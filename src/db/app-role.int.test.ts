import { inspect } from "node:util";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  openOwnerDatabase,
  ownerDatabaseSettings,
  testDatabaseSettings,
} from "../../test/integration/database";
import { provisionAppRole } from "./app-role";

describe("provisionAppRole when the database refuses", () => {
  const password = "must-not-reach-the-logs";

  // Everything Node's error printer can reach.
  const printed = (error: unknown) =>
    inspect(error, { depth: null, showHidden: true });

  it("reports the SQLSTATE and nothing that holds the password", async () => {
    // Connected as app_tenant, which can't give itself LOGIN: ALTER ROLE really
    // fails, and leaves the shared role as it was.
    const error = await provisionAppRole(
      testDatabaseSettings(),
      `postgres://app_tenant:${password}@host/db`,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(printed(error)).toContain("42501");
    expect(printed(error)).not.toContain(password);
    expect(printed(error)).not.toMatch(/alter role/i);
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("provisionAppRole on a role RLS doesn't apply to", () => {
  // Roles are per cluster, so these tests never touch the shared app_tenant:
  // each uses throwaway roles, and a throwaway schema because the RLS coverage
  // test reads every table in public.
  const owner = openOwnerDatabase();
  afterAll(() => owner.pool.end());

  const suffix = crypto.randomUUID().slice(0, 8);
  const probe = `probe_${suffix}`;
  const parent = `probe_parent_${suffix}`;
  const schema = `probe_${suffix}`;

  const run = (statement: string) => owner.db.execute(sql.raw(statement));
  const provisionProbe = () =>
    provisionAppRole(
      ownerDatabaseSettings(),
      `postgres://${probe}:probe-password@host/db`,
      probe,
    );

  afterEach(async () => {
    await run(`drop schema if exists ${schema} cascade`);
    await run(`drop role if exists ${probe}`);
    await run(`drop role if exists ${parent}`);
  });

  it("accepts a role with none of the exemptions, and lets it log in", async () => {
    await run(`create role ${probe} nologin`);
    await provisionProbe();
    const { rows } = await owner.db.execute(
      sql`select rolcanlogin from pg_roles where rolname = ${probe}`,
    );
    expect(rows).toEqual([{ rolcanlogin: true }]);
  });

  it("refuses a superuser", async () => {
    await run(`create role ${probe} superuser`);
    await expect(provisionProbe()).rejects.toThrow(/superuser/);
  });

  it("refuses BYPASSRLS", async () => {
    await run(`create role ${probe} bypassrls`);
    await expect(provisionProbe()).rejects.toThrow(/BYPASSRLS/);
  });

  it("refuses a role that owns a table", async () => {
    await run(`create role ${probe}`);
    await run(`create schema ${schema}`);
    await run(`create table ${schema}.owned (id int)`);
    await run(`alter table ${schema}.owned owner to ${probe}`);
    await expect(provisionProbe()).rejects.toThrow(/owns a table/);
  });

  it("refuses a member of a BYPASSRLS role", async () => {
    await run(`create role ${parent} bypassrls`);
    await run(`create role ${probe} in role ${parent}`);
    await expect(provisionProbe()).rejects.toThrow(
      new RegExp(`${parent}.*BYPASSRLS`),
    );
  });

  it("refuses a member of a superuser role", async () => {
    await run(`create role ${parent} superuser`);
    await run(`create role ${probe} in role ${parent}`);
    await expect(provisionProbe()).rejects.toThrow(
      new RegExp(`${parent}.*superuser`),
    );
  });

  it("refuses a member of a role that owns a table, whose ownership it inherits", async () => {
    await run(`create role ${parent}`);
    await run(`create role ${probe} in role ${parent}`);
    await run(`create schema ${schema}`);
    await run(`create table ${schema}.owned (id int)`);
    await run(`alter table ${schema}.owned owner to ${parent}`);
    await expect(provisionProbe()).rejects.toThrow(
      new RegExp(`${parent}.*owns a table`),
    );
  });
});
