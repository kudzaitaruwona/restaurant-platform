import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, restaurants, staff } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { installFakeServices } from "../../test/integration/fake-services";
import { importRestaurants, previewRestaurantsImport } from "./restaurant-import";
import { devPlatformAdmin } from "./tenant/dev-identities";

/**
 * The platform functions run as app_admin (DATABASE_URL_ADMIN, pointed at the
 * test database by vitest.config.mts). Restaurants made here stay behind: one
 * with an owner can't lose it (S-26).
 */
const owner = openOwnerDatabase();
const admin = { platformAdminId: devPlatformAdmin.platformAdminId };

let services: ReturnType<typeof installFakeServices>;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  services = installFakeServices();
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const header = "restaurant_name,slug,timezone,currency_mode,owner_email,owner_name";
const run = () => crypto.randomUUID().slice(0, 8);
const email = () => `${crypto.randomUUID()}@example.test`;

const report = <T,>(result: T) => {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(String((result as { error: string }).error));
  }
  return result as Exclude<T, { error: string }>;
};

const bySlug = (slugs: string[]) =>
  owner.db
    .select({
      id: restaurants.id,
      name: restaurants.name,
      slug: restaurants.slug,
      timezone: restaurants.timezone,
      currencyMode: restaurants.currencyMode,
    })
    .from(restaurants)
    .where(inArray(restaurants.slug, slugs));

describe("previewRestaurantsImport", () => {
  it("checks each row with the single forms' rules and writes nothing", async () => {
    const id = run();
    const [existing] = await owner.db.select({ slug: restaurants.slug }).from(restaurants).limit(1);
    const csv = [
      header,
      `Kitchen ${id},kitchen-${id},,,${email()},Chipo`,
      `!!!,,,,${email()},Chipo`, // no slug can be made from the name
      `Taken ${id},${existing.slug},,,${email()},Chipo`,
      `Again ${id},kitchen-${id},,,${email()},Chipo`, // slug repeated in the file
      `Zone ${id},zone-${id},Mars/Olympus,,${email()},Chipo`,
      `Money ${id},money-${id},,dollars,${email()},Chipo`,
      `Owner ${id},owner-${id},,,not-an-email,Chipo`,
      `Nameless ${id},nameless-${id},,,${email()},`,
    ].join("\n");

    const preview = report(await previewRestaurantsImport(admin, csv));

    expect(preview.rows.map((row) => row.problems)).toEqual([
      [],
      ["Add a slug: one can't be made from this name."],
      [`The slug ${existing.slug} is already in use.`],
      [`The slug kitchen-${id} is already in this file, on line 2.`],
      ["Enter a timezone like Africa/Harare."],
      ["Choose a currency mode."],
      ["Enter an email address."],
      ["Enter a name."],
    ]);
    expect(await bySlug([`kitchen-${id}`, `zone-${id}`])).toEqual([]);
  });

  it("makes the slug from the name and fills the defaults, and says so", async () => {
    const id = run();
    const preview = report(
      await previewRestaurantsImport(admin, `${header}\nMama's Café ${id},,,,${email()},Chipo`),
    );

    expect(preview.rows[0]).toMatchObject({
      problems: [],
      notes: [
        `The slug will be mama-s-cafe-${id}.`,
        "No timezone given, so Africa/Harare.",
        "No currency mode given, so usd_primary.",
      ],
    });
  });

  it("refuses an owner email repeated in the file", async () => {
    const id = run();
    const repeated = email();
    const preview = report(
      await previewRestaurantsImport(
        admin,
        `${header}\nOne ${id},one-${id},,,${repeated},A\nTwo ${id},two-${id},,,${repeated.toUpperCase()},B`,
      ),
    );

    expect(preview.rows[1].problems).toEqual([`${repeated} is already in this file, on line 2.`]);
  });
});

describe("importRestaurants", () => {
  it("creates each restaurant and its owner through the platform functions, audited by them", async () => {
    const id = run();
    const ownerEmail = email();
    const csv = `${header}\nKitchen ${id},kitchen-${id},Africa/Johannesburg,both,${ownerEmail.toUpperCase()},Chipo Dube\nGrill ${id},,,,${email()},Farai\nBad ${id},,,,nope,X`;

    const result = report(await importRestaurants(admin, csv));

    expect(result).toMatchObject({ imported: 2 });
    expect(result.rows.map((row) => row.problems.length)).toEqual([0, 0, 1]);
    const made = await bySlug([`kitchen-${id}`, `grill-${id}`]);
    expect(made.map(({ name, slug, timezone, currencyMode }) => ({ name, slug, timezone, currencyMode })).sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { name: `Grill ${id}`, slug: `grill-${id}`, timezone: "Africa/Harare", currencyMode: "usd_primary" },
      { name: `Kitchen ${id}`, slug: `kitchen-${id}`, timezone: "Africa/Johannesburg", currencyMode: "both" },
    ]);
    const kitchen = made.find((restaurant) => restaurant.slug === `kitchen-${id}`)!;
    expect(
      await owner.db
        .select({ email: staff.email, displayName: staff.displayName, role: staff.role })
        .from(staff)
        .where(eq(staff.restaurantId, kitchen.id)),
    ).toEqual([{ email: ownerEmail, displayName: "Chipo Dube", role: "owner" }]);
    const actions = (
      await owner.db
        .select({ action: auditLog.action, actorId: auditLog.actorId })
        .from(auditLog)
        .where(eq(auditLog.restaurantId, kitchen.id))
    ).map((entry) => entry.action);
    expect(actions).toContain("staff.create");
  });

  it("invites each owner it creates (S-42), and says on the row when the email didn't go", async () => {
    const id = run();
    const invited = email();
    const refused = email();
    services.refusing.add(refused);
    const csv = `${header}\nInvite ${id},,,,${invited},Rudo\nNo mail ${id},,,,${refused},Tendai`;

    const result = report(await importRestaurants(admin, csv));

    expect(result).toMatchObject({ imported: 2 });
    expect(services.sent.some((sent) => sent.to.includes(invited))).toBe(true);
    expect(result.rows[0].notes.join(" ")).not.toMatch(/invite email didn't go/);
    expect(result.rows[1].notes).toContain(
      "The owner was added, but the invite email didn't go. Send it again from the restaurant's card.",
    );
  });

  it("says when the restaurant was made but its owner's email was taken", async () => {
    const id = run();
    const [someone] = await owner.db.select({ email: staff.email }).from(staff).where(eq(staff.kind, "staff")).limit(1);

    const result = report(
      await importRestaurants(admin, `${header}\nTaken owner ${id},taken-owner-${id},,,${someone.email},Chipo`),
    );

    expect(result.imported).toBe(1);
    expect(result.rows[0].notes).toContain(
      "The restaurant was created, but not its owner: that email is already in use. Add the owner from the restaurant's card.",
    );
    expect(await bySlug([`taken-owner-${id}`])).toHaveLength(1);
  });

  it("reports a slug already in use, and goes on with the rest", async () => {
    const id = run();
    await importRestaurants(admin, `${header}\nFirst ${id},race-${id},,,${email()},A`);

    const result = report(
      await importRestaurants(admin, `${header}\nSecond ${id},race-${id},,,${email()},B\nThird ${id},third-${id},,,${email()},C`),
    );

    expect(result.imported).toBe(1);
    expect(result.rows[0].problems).toEqual([`The slug race-${id} is already in use.`]);
  });
});
