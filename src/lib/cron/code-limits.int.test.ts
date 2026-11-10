import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { adminAuthCodeLimit, staffAuthCodeLimit } from "@/db/schema";
import { openOwnerDatabase, openSystemDatabase } from "../../../test/integration/database";
import { pruneCodeLimits } from "./code-limits";

/**
 * S-30's retention: a sign-in code row past its 24-hour window has no further
 * use, because the next attempt starts a fresh one, and rows are keyed by
 * whatever address someone typed. The job prunes them. Like the status rules,
 * this runs in 1990, so it can't touch a row another test is counting.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
afterAll(() => Promise.all([owner.pool.end(), system.pool.end()]));

const NOW = new Date("1990-06-01T18:00:00Z");
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);

describe.each([
  ["staff", staffAuthCodeLimit],
  ["admin", adminAuthCodeLimit],
])("the %s sign-in code ceiling", (_audience, table) => {
  it("forgets an address once its window is over, and keeps one still inside it", async () => {
    const tag = crypto.randomUUID();
    const rows = {
      over: { email: `over-${tag}@example.test`, attempts: 20, windowStartedAt: hoursAgo(25) },
      justOver: { email: `just-over-${tag}@example.test`, attempts: 3, windowStartedAt: hoursAgo(24) },
      inside: { email: `inside-${tag}@example.test`, attempts: 20, windowStartedAt: hoursAgo(23) },
    };
    await owner.db.insert(table).values(Object.values(rows));

    expect(await pruneCodeLimits(system.db, NOW)).toBeGreaterThanOrEqual(2);
    // Twice, as an overlapping run would: nothing more goes.
    await pruneCodeLimits(system.db, NOW);

    const left = await owner.db
      .select({ email: table.email })
      .from(table)
      .where(inArray(table.email, Object.values(rows).map(({ email }) => email)));
    expect(left).toEqual([{ email: rows.inside.email }]);
  });
});
