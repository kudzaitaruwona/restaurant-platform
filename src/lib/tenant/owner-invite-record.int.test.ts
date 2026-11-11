import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openOwnerDatabase } from "../../../test/integration/database";
import { installFakeServices } from "../../../test/integration/fake-services";
import { devPlatformAdmin } from "./dev-identities";
import { createFirstOwner, createRestaurant, resendOwnerInvite } from "./platform-admin";

/**
 * The owner's invite once the email has gone (S-42): failing to record how it
 * went must not turn a sent email into a failed one. Only Resend is fake, and
 * platform_finish_invite is made to fail when `finish.fails` is set.
 */
const finish = vi.hoisted(() => ({ fails: false }));
vi.mock("@/db/admin", async (importOriginal) => {
  const real: { getAdminDb: () => { execute: (query: SQL) => Promise<unknown> } } =
    await importOriginal();
  const dialect = new PgDialect();
  return {
    getAdminDb: () => {
      const db = real.getAdminDb();
      return new Proxy(db, {
        get(target, key, receiver) {
          if (key !== "execute") return Reflect.get(target, key, receiver);
          return (query: SQL) => {
            if (finish.fails && dialect.sqlToQuery(query).sql.includes("platform_finish_invite")) {
              return Promise.reject(new Error("connection lost"));
            }
            return target.execute(query);
          };
        },
      });
    },
  };
});

const owner = openOwnerDatabase();
const admin = { platformAdminId: devPlatformAdmin.platformAdminId };
let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  services = installFakeServices();
});
beforeEach(() => {
  finish.fails = false;
  services.sent.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function newRestaurant() {
  const created = await createRestaurant(admin, {
    name: "Record Kitchen",
    slug: `invite-record-${crypto.randomUUID()}`,
    timezone: "Africa/Harare",
    currencyMode: "usd_only",
  });
  if (!("id" in created)) throw new Error("No restaurant");
  return created.id;
}

const newOwner = () => ({ email: `${crypto.randomUUID()}@example.test`, displayName: "Rudo Chari" });

describe("when the email goes but recording it fails", () => {
  it("still says the first owner was invited", async () => {
    const restaurantId = await newRestaurant();
    const person = newOwner();
    finish.fails = true;

    const created = await createFirstOwner(admin, restaurantId, person);

    expect(created).toMatchObject({ id: expect.any(String), invited: true });
    await services.emailTo(person.email);
    expect(console.error).toHaveBeenCalled();
  });

  it("still says a resend went", async () => {
    const restaurantId = await newRestaurant();
    const person = newOwner();
    const created = await createFirstOwner(admin, restaurantId, person);
    if (!("id" in created)) throw new Error("No owner");
    finish.fails = true;

    expect(await resendOwnerInvite(admin, restaurantId, created.id)).toBe("sent");
  });
});
