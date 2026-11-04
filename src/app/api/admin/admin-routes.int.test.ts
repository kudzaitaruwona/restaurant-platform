import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, onboardingChecklist, restaurants, staff } from "@/db/schema";
import { devPlatformAdmin, devRestaurants } from "@/lib/tenant/dev-identities";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../test/integration/database";
import { statusOf } from "../../../../test/integration/http";

const session = vi.hoisted(() => ({ identity: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({ name, value: session.identity }),
  }),
}));

const SLUG_PREFIX = "routes-test-";
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
});
beforeEach(() => {
  session.identity = devPlatformAdmin.key;
});
afterAll(async () => {
  // Restaurants created here stay behind: one with an owner can't lose it (S-26).
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const post = (path: string, fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: "POST",
    body,
  });
};

const newSlug = () => `${SLUG_PREFIX}${crypto.randomUUID()}`;
const newEmail = () => `${crypto.randomUUID()}@example.test`;

const validRestaurant = () => ({
  name: "Mama's Kitchen",
  slug: newSlug(),
  timezone: "Africa/Harare",
  currencyMode: "both",
});

async function createRestaurant(fields: Record<string, string>) {
  const { POST } = await import("./restaurants/route");
  return POST(post("/api/admin/restaurants", fields));
}

async function createOwner(restaurantId: string, fields: Record<string, string>) {
  const { POST } = await import("./restaurants/[restaurantId]/owner/route");
  return POST(post(`/api/admin/restaurants/${restaurantId}/owner`, fields), {
    params: Promise.resolve({ restaurantId }),
  });
}

async function enter(restaurantId: string) {
  const { POST } = await import("./restaurants/[restaurantId]/enter/route");
  return POST(
    new NextRequest(
      new URL(`/api/admin/restaurants/${restaurantId}/enter`, "http://localhost:3000"),
      { method: "POST" },
    ),
    { params: Promise.resolve({ restaurantId }) },
  );
}

async function tickQrCodes(restaurantId: string, fields: Record<string, string>) {
  const { POST } = await import("./restaurants/[restaurantId]/qr-codes-printed/route");
  return POST(
    post(`/api/admin/restaurants/${restaurantId}/qr-codes-printed`, fields),
    { params: Promise.resolve({ restaurantId }) },
  );
}

const isTicked = async (restaurantId: string) =>
  (
    await owner.db
      .select()
      .from(onboardingChecklist)
      .where(eq(onboardingChecklist.restaurantId, restaurantId))
  ).length === 1;

const restaurantRow = async (id: string) =>
  (await owner.db.select().from(restaurants).where(eq(restaurants.id, id)))[0];

const staffOf = (restaurantId: string) =>
  owner.db.select().from(staff).where(eq(staff.restaurantId, restaurantId));

const created = async (response: Response) => {
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

const validOwner = () => ({ email: newEmail(), displayName: "Tendai Moyo" });

describe("POST /api/admin/restaurants", () => {
  it("creates a restaurant with what the form sent", async () => {
    const fields = validRestaurant();

    const id = await created(await createRestaurant(fields));

    expect(await restaurantRow(id)).toMatchObject({
      name: "Mama's Kitchen",
      slug: fields.slug,
      timezone: "Africa/Harare",
      currencyMode: "both",
    });
  });

  it("defaults a blank timezone to Africa/Harare", async () => {
    const id = await created(
      await createRestaurant({ ...validRestaurant(), timezone: "" }),
    );
    expect((await restaurantRow(id)).timezone).toBe("Africa/Harare");
  });

  it("defaults a missing timezone to Africa/Harare", async () => {
    const fields: Record<string, string> = validRestaurant();
    delete fields.timezone;

    const id = await created(await createRestaurant(fields));

    expect((await restaurantRow(id)).timezone).toBe("Africa/Harare");
  });

  it.each(["Asia/Kolkata", "Etc/GMT+2"])(
    "takes %s, which the settings screen must then cope with",
    async (timezone) => {
      const id = await created(
        await createRestaurant({ ...validRestaurant(), timezone }),
      );
      expect((await restaurantRow(id)).timezone).toBe(timezone);
    },
  );

  it("takes another timezone", async () => {
    const id = await created(
      await createRestaurant({ ...validRestaurant(), timezone: "Europe/London" }),
    );
    expect((await restaurantRow(id)).timezone).toBe("Europe/London");
  });

  it("lowercases the slug, since it's a public URL", async () => {
    const slug = newSlug();
    const id = await created(
      await createRestaurant({ ...validRestaurant(), slug: slug.toUpperCase() }),
    );
    expect((await restaurantRow(id)).slug).toBe(slug);
  });

  it("is a 409 with a usable message when the slug is taken", async () => {
    const response = await createRestaurant({
      ...validRestaurant(),
      slug: devRestaurants[0].slug,
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That slug is already in use.",
    });
  });

  it.each([
    ["no name", { name: "   " }],
    ["a long name", { name: "x".repeat(201) }],
    ["no slug", { slug: "" }],
    ["spaces in the slug", { slug: "mamas kitchen" }],
    ["a slug that isn't a path segment", { slug: "../admin" }],
    ["a slug with a trailing hyphen", { slug: "mamas-" }],
    ["a long slug", { slug: "x".repeat(64) }],
    ["an unknown timezone", { timezone: "Mars/Olympus" }],
    ["an offset, which Postgres doesn't know", { timezone: "+02:00" }],
    ["a timezone in the wrong case", { timezone: "africa/harare" }],
    ["a timezone abbreviation", { timezone: "CAT" }],
    ["no currency mode", { currencyMode: "" }],
    ["an unknown currency mode", { currencyMode: "gold" }],
  ])("is a 400 for %s", async (_label, change) => {
    const response = await createRestaurant({ ...validRestaurant(), ...change });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
  });
});

describe("POST /api/admin/restaurants/[restaurantId]/owner", () => {
  const newRestaurant = async () =>
    created(await createRestaurant(validRestaurant()));

  it("creates the owner, and the new restaurant's owner is the only one in it", async () => {
    const restaurantId = await newRestaurant();
    const fields = validOwner();

    const id = await created(await createOwner(restaurantId, fields));

    expect(await staffOf(restaurantId)).toMatchObject([
      {
        id,
        email: fields.email,
        displayName: "Tendai Moyo",
        role: "owner",
        kind: "staff",
      },
    ]);
  });

  it("writes an audit entry, readable inside that tenant and no other", async () => {
    const restaurantId = await newRestaurant();
    const id = await created(await createOwner(restaurantId, validOwner()));
    const { withTenant } = await import("@/lib/tenant");
    const entries = (tenant: string) =>
      withTenant({ restaurantId: tenant }, (tx) =>
        tx.select().from(auditLog).where(eq(auditLog.entityId, id)),
      );

    expect(await entries(restaurantId)).toMatchObject([
      {
        action: "staff.create",
        actorType: "platform_admin",
        actorId: devPlatformAdmin.platformAdminId,
      },
    ]);
    expect(await entries(devRestaurants[0].id)).toEqual([]);
  });

  it("stores the email lowercased: sign-in matches on it exactly", async () => {
    const restaurantId = await newRestaurant();
    const email = newEmail();

    await created(
      await createOwner(restaurantId, {
        ...validOwner(),
        email: `  ${email.toUpperCase()} `,
      }),
    );

    expect((await staffOf(restaurantId))[0].email).toBe(email);
  });

  it("is a 409 once the restaurant has its first staff record", async () => {
    const restaurantId = await newRestaurant();
    await created(await createOwner(restaurantId, validOwner()));

    const response = await createOwner(restaurantId, validOwner());

    expect(response.status).toBe(409);
    expect(await staffOf(restaurantId)).toHaveLength(1);
  });

  it("is a 409 when the email belongs to someone else in another case", async () => {
    const taken = `${crypto.randomUUID()}@example.test`;
    await owner.db.insert(staff).values({
      restaurantId: devRestaurants[0].id,
      email: taken.toUpperCase(),
      displayName: "Entered by hand",
    });
    const restaurantId = await newRestaurant();

    const response = await createOwner(restaurantId, { email: taken, displayName: "Owner" });

    expect(response.status).toBe(409);
    await owner.db.delete(staff).where(eq(staff.email, taken.toUpperCase()));
  });

  it("is a 409 when the email belongs to someone else", async () => {
    const fields = validOwner();
    await created(await createOwner(await newRestaurant(), fields));
    const restaurantId = await newRestaurant();

    const response = await createOwner(restaurantId, fields);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "That email is already in use.",
    });
    expect(await staffOf(restaurantId)).toEqual([]);
  });

  it.each([
    ["a bad email", { email: "not-an-email" }],
    ["no name", { displayName: " " }],
    ["a long name", { displayName: "x".repeat(201) }],
  ])("is a 400 for %s", async (_label, change) => {
    const restaurantId = await newRestaurant();

    const response = await createOwner(restaurantId, {
      ...validOwner(),
      ...change,
    });

    expect(response.status).toBe(400);
    expect(await staffOf(restaurantId)).toEqual([]);
  });

  it("is a 404 for a restaurant that doesn't exist", async () => {
    expect(
      await statusOf(() => createOwner(crypto.randomUUID(), validOwner())),
    ).toBe(404);
  });

  it.each(["not-a-uuid", "", "'; drop table staff; --"])(
    "a malformed id is a 404, not an error: %j",
    async (restaurantId) => {
      expect(
        await statusOf(() => createOwner(restaurantId, validOwner())),
      ).toBe(404);
    },
  );
});

describe("POST /api/admin/restaurants/[restaurantId]/enter", () => {
  it("is a 404 for a restaurant that doesn't exist", async () => {
    expect(await statusOf(() => enter(crypto.randomUUID()))).toBe(404);
  });

  it.each(["not-a-uuid", "", "'; drop table staff; --"])(
    "a malformed id is a 404, not an error: %j",
    async (restaurantId) => {
      expect(await statusOf(() => enter(restaurantId))).toBe(404);
    },
  );
});

describe("POST /api/admin/restaurants/[restaurantId]/qr-codes-printed", () => {
  it("ticks the box and unticks it, and the tick is still there afterwards", async () => {
    const id = await created(await createRestaurant(validRestaurant()));

    expect((await tickQrCodes(id, { printed: "true" })).status).toBe(200);
    expect(await isTicked(id)).toBe(true);

    expect((await tickQrCodes(id, { printed: "false" })).status).toBe(200);
    expect(await isTicked(id)).toBe(false);
  });

  it("audits the tick as the platform admin", async () => {
    const id = await created(await createRestaurant(validRestaurant()));

    await tickQrCodes(id, { printed: "true" });

    const entries = await owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, id));
    expect(entries.map(({ action }) => action)).toContain("onboarding.qr_codes_printed");
  });

  it.each<Record<string, string>>([{}, { printed: "" }, { printed: "yes" }])(
    "is a 400 without a clear true or false, and changes nothing: %j",
    async (fields) => {
      const id = await created(await createRestaurant(validRestaurant()));

      expect((await tickQrCodes(id, fields)).status).toBe(400);
      expect(await isTicked(id)).toBe(false);
    },
  );

  it("is a 404 for a restaurant that doesn't exist", async () => {
    expect(
      await statusOf(() => tickQrCodes(crypto.randomUUID(), { printed: "true" })),
    ).toBe(404);
  });

  it.each(["not-a-uuid", "", "'; drop table staff; --"])(
    "a malformed id is a 404, not an error: %j",
    async (restaurantId) => {
      expect(
        await statusOf(() => tickQrCodes(restaurantId, { printed: "true" })),
      ).toBe(404);
    },
  );
});
