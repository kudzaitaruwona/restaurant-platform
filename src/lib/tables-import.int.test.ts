import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, diningTables, restaurants } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../test/integration/database";
import { addTable, archiveTable, listTables } from "./tables";
import { importTables, previewTablesImport } from "./tables-import";

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

/**
 * Every insert the import's transaction makes, by table; and, when `race.plant`
 * is set, another owner's add that commits just before the tables go in.
 */
const inserts = vi.hoisted(() => ({ into: [] as unknown[] }));
const race = vi.hoisted(() => ({ plant: undefined as undefined | (() => Promise<void>) }));
vi.mock("@/lib/tenant/scope", async (importOriginal) => {
  const scope = await importOriginal<typeof import("@/lib/tenant/scope")>();
  const withTenant: typeof scope.withTenant = (ctx, fn) =>
    scope.withTenant(ctx, (tx) =>
      fn(
        new Proxy(tx, {
          get(target, key, receiver) {
            if (key !== "insert") return Reflect.get(target, key, receiver);
            return (table: Parameters<typeof target.insert>[0]) => {
              inserts.into.push(table);
              const plant = race.plant;
              if (!plant) return target.insert(table);
              race.plant = undefined;
              type Values = Parameters<ReturnType<typeof target.insert>["values"]>[0];
              return { values: (rows: Values) => plant().then(() => target.insert(table).values(rows)) };
            };
          },
        }),
      ),
    );
  return { ...scope, withTenant };
});

/** Runs as app_tenant, so everything here also holds under RLS. */
const owner = openOwnerDatabase();
const created: string[] = [];

async function newRestaurant() {
  const restaurantId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Import Tables",
    slug: `tables-import-${restaurantId}`,
    menuToken: `tables-import-${restaurantId}`,
    currencyMode: "usd_only",
  });
  created.push(restaurantId);
  return { restaurantId, staffId: crypto.randomUUID(), role: "owner" as const };
}

const auditOf = (restaurantId: string) =>
  owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

const tablesOf = (restaurantId: string) =>
  owner.db
    .select({
      label: diningTables.label,
      capacity: diningTables.capacity,
      bookable: diningTables.bookable,
      sortOrder: diningTables.sortOrder,
    })
    .from(diningTables)
    .where(eq(diningTables.restaurantId, restaurantId))
    .orderBy(asc(diningTables.sortOrder));

const report = <T,>(result: T) => {
  if (result && typeof result === "object" && "error" in result) {
    throw new Error(String((result as { error: string }).error));
  }
  return result as Exclude<T, { error: string }>;
};

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
beforeEach(() => {
  inserts.into.length = 0;
});

afterAll(async () => {
  await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, created));
  await owner.db.delete(diningTables).where(inArray(diningTables.restaurantId, created));
  await owner.db.delete(restaurants).where(inArray(restaurants.id, created));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

describe("previewTablesImport", () => {
  it("checks each row with the table form's rules and writes nothing", async () => {
    const tenant = await newRestaurant();
    await addTable(tenant, { label: "1", capacity: 4 });
    const csv = [
      "label,seats,bookable",
      "1,4,yes", // exists
      "2,0,", // too few seats
      "3,101,", // too many
      ",2,", // no label
      `${"x".repeat(51)},2,`, // label too long
      "4,2,sometimes",
      "5,2,no",
      "5,3,", // repeated in the file
      "6,1e1,", // not digits
    ].join("\n");

    const preview = report(await previewTablesImport(tenant, csv));

    expect(preview.rows.map((row) => row.problems)).toEqual([
      ["Table 1 already exists."],
      ["Enter how many people the table seats, from 1 to 100."],
      ["Enter how many people the table seats, from 1 to 100."],
      ["Enter the table's label, up to 50 characters."],
      ["Enter the table's label, up to 50 characters."],
      ['Write yes or no in "bookable", or leave it blank for yes.'],
      [],
      ["Table 5 is already in this file, on line 8."],
      ["Enter how many people the table seats, from 1 to 100."],
    ]);
    expect(preview.ready).toBe(1);
    expect(await tablesOf(tenant.restaurantId)).toHaveLength(1);
  });

  it("frees an archived table's label, as the single form does", async () => {
    const tenant = await newRestaurant();
    await addTable(tenant, { label: "1", capacity: 4 });
    const [table] = await listTables(tenant);
    await archiveTable(tenant, table.id);

    const preview = report(await previewTablesImport(tenant, "label,seats\n1,2"));
    expect(preview.rows[0].problems).toEqual([]);
  });
});

describe("importTables", () => {
  it("adds every valid row in one go, after the existing tables, each with its own token", async () => {
    const tenant = await newRestaurant();
    await addTable(tenant, { label: "1", capacity: 4 });

    const result = report(
      await importTables(tenant, "Label;Seats;Bookable\r\n2;2;yes\r\nBar 1;2;no\r\n3;0;\r\n"),
    );

    expect(result).toMatchObject({ ready: 2, imported: 2 });
    expect(await tablesOf(tenant.restaurantId)).toEqual([
      { label: "1", capacity: 4, bookable: true, sortOrder: 0 },
      { label: "2", capacity: 2, bookable: true, sortOrder: 1 },
      { label: "Bar 1", capacity: 2, bookable: false, sortOrder: 2 },
    ]);
    const tokens = (await listTables(tenant)).map((table) => table.qrToken);
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) expect(token).toMatch(/^[0-9A-Za-z]{22}$/);
  });

  it("is audited once with the counts, and not at all when nothing is added", async () => {
    const tenant = await newRestaurant();

    await importTables(tenant, "label,seats\n1,0");
    expect(await auditOf(tenant.restaurantId)).toEqual([]);

    await importTables(tenant, "label,seats\n1,2\n2,2\n3,0");
    expect(await auditOf(tenant.restaurantId)).toEqual([
      expect.objectContaining({
        action: "table.import",
        entityType: "restaurant",
        entityId: tenant.restaurantId,
        actorType: "staff",
        actorId: tenant.staffId,
        details: { tables: 2, skipped: 1 },
      }),
    ]);
  });

  it("records an entered platform admin, once", async () => {
    const tenant = { ...(await newRestaurant()), platformAdminId: crypto.randomUUID() };

    await importTables(tenant, "label,seats\n1,2\n2,2");

    const entries = await auditOf(tenant.restaurantId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "platform_admin", actorId: tenant.platformAdminId });
  });

  it("adds nothing if a label is taken between the check and the insert", async () => {
    const tenant = await newRestaurant();
    race.plant = async () => {
      await addTable(tenant, { label: "2", capacity: 2 });
    };

    const result = await importTables(tenant, "label,seats\n1,2\n2,2");

    expect(result).toEqual({ error: "Another table took one of these labels just now. Check the file again." });
    expect((await tablesOf(tenant.restaurantId)).map((table) => table.label)).toEqual(["2"]);
  });

  it("adds a whole file in one insert, in file order after the existing tables", async () => {
    const tenant = await newRestaurant();
    await addTable(tenant, { label: "1", capacity: 4 });
    const labels = Array.from({ length: 150 }, (_, i) => `T${i}`);
    inserts.into.length = 0;

    const result = report(
      await importTables(tenant, ["label,seats", ...labels.map((label) => `${label},2`)].join("\n")),
    );

    expect(result.imported).toBe(150);
    expect(inserts.into.filter((table) => table === diningTables)).toHaveLength(1);
    expect((await tablesOf(tenant.restaurantId)).map(({ label, sortOrder }) => ({ label, sortOrder }))).toEqual([
      { label: "1", sortOrder: 0 },
      ...labels.map((label, i) => ({ label, sortOrder: i + 1 })),
    ]);
    const tokens = (await listTables(tenant)).map((table) => table.qrToken);
    expect(new Set(tokens).size).toBe(151);
    expect(await auditOf(tenant.restaurantId)).toEqual([
      expect.objectContaining({ action: "table.import", details: { tables: 150, skipped: 0 } }),
    ]);
  });
});
