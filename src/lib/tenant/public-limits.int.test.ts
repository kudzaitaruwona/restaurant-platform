import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookingRateLimit } from "@/db/schema";
import { SUBMISSIONS_PER_WINDOW } from "@/lib/booking-limits";
import { openOwnerDatabase, testDatabaseSettings } from "../../../test/integration/database";
import { pruneSubmissions, spendSubmission } from "./public-limits";

/** The count behind the guest's rate limit, in a real database, as app_tenant. */
const owner = openOwnerDatabase();
const keys: string[] = [];
const newKey = () => {
  const key = `test-${crypto.randomUUID()}`;
  keys.push(key);
  return key;
};

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  for (const key of keys) await owner.db.delete(bookingRateLimit).where(eq(bookingRateLimit.key, key));
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const rowOf = async (key: string) =>
  (await owner.db.select().from(bookingRateLimit).where(eq(bookingRateLimit.key, key)))[0];

describe("spending a submission", () => {
  it("allows five and refuses the sixth, with how long to wait", async () => {
    const key = newKey();
    for (let attempt = 1; attempt <= SUBMISSIONS_PER_WINDOW; attempt++) {
      expect(await spendSubmission(key)).toMatchObject({ allowed: true });
    }

    const refused = await spendSubmission(key);

    expect(refused.allowed).toBe(false);
    expect(refused).toMatchObject({ retryAfterSeconds: expect.any(Number) });
    const { retryAfterSeconds } = refused as { retryAfterSeconds: number };
    expect(retryAfterSeconds).toBeGreaterThan(590);
    expect(retryAfterSeconds).toBeLessThanOrEqual(600);
  });

  it("counts each visitor on their own", async () => {
    const [one, other] = [newKey(), newKey()];
    for (let attempt = 0; attempt < SUBMISSIONS_PER_WINDOW + 1; attempt++) await spendSubmission(one);

    expect(await spendSubmission(other)).toMatchObject({ allowed: true });
  });

  it("lets exactly five of a burst of parallel posts through", async () => {
    const key = newKey();

    const answers = await Promise.all(Array.from({ length: 12 }, () => spendSubmission(key)));

    expect(answers.filter((answer) => answer.allowed)).toHaveLength(SUBMISSIONS_PER_WINDOW);
  });

  it("doesn't extend the window by being refused, or count past one over", async () => {
    const key = newKey();
    for (let attempt = 0; attempt < 20; attempt++) await spendSubmission(key);

    const row = await rowOf(key);
    expect(row.attempts).toBe(SUBMISSIONS_PER_WINDOW + 1);
    expect(Date.now() - row.windowStartedAt.getTime()).toBeLessThan(60_000);
  });

  it("starts a new window once ten minutes have passed", async () => {
    const key = newKey();
    for (let attempt = 0; attempt < SUBMISSIONS_PER_WINDOW + 1; attempt++) await spendSubmission(key);
    expect((await spendSubmission(key)).allowed).toBe(false);

    await owner.db
      .update(bookingRateLimit)
      .set({ windowStartedAt: sql`now() - interval '10 minutes 1 second'` })
      .where(eq(bookingRateLimit.key, key));

    expect(await spendSubmission(key)).toMatchObject({ allowed: true });
    expect((await rowOf(key)).attempts).toBe(1);
  });

  it("still refuses a second before the ten minutes are up", async () => {
    const key = newKey();
    for (let attempt = 0; attempt < SUBMISSIONS_PER_WINDOW + 1; attempt++) await spendSubmission(key);
    await owner.db
      .update(bookingRateLimit)
      .set({ windowStartedAt: sql`now() - interval '9 minutes 59 seconds'` })
      .where(eq(bookingRateLimit.key, key));

    expect((await spendSubmission(key)).allowed).toBe(false);
  });
});

describe("giving a submission back (#134)", () => {
  /** Spends one that is allowed, and what gives it back. */
  const spend = async (key: string) => {
    const spent = await spendSubmission(key);
    if (!spent.allowed) throw new Error("refused");
    return spent.giveBack;
  };

  it("uncounts that one", async () => {
    const key = newKey();
    await spend(key);
    const giveBack = await spend(key);

    await giveBack();

    expect((await rowOf(key)).attempts).toBe(1);
  });

  it("counts what was allowed, not the refusals the count stops at", async () => {
    const key = newKey();
    for (let attempt = 1; attempt < SUBMISSIONS_PER_WINDOW; attempt++) await spendSubmission(key);
    const giveBack = await spend(key);
    for (let attempt = 0; attempt < 3; attempt++) await spendSubmission(key);

    await giveBack();

    expect((await spendSubmission(key)).allowed).toBe(true);
    expect((await spendSubmission(key)).allowed).toBe(false);
  });

  it("gives nothing back to a window it wasn't counted in", async () => {
    const key = newKey();
    const giveBack = await spend(key);
    await owner.db
      .update(bookingRateLimit)
      .set({ windowStartedAt: sql`now() - interval '10 minutes 1 second'` })
      .where(eq(bookingRateLimit.key, key));
    await spend(key);

    await giveBack();

    expect((await rowOf(key)).attempts).toBe(1);
  });
});

describe("pruning", () => {
  it("removes rows whose window ended over an hour ago and keeps the rest", async () => {
    const [old, recent] = [newKey(), newKey()];
    await spendSubmission(old);
    await spendSubmission(recent);
    await owner.db
      .update(bookingRateLimit)
      .set({ windowStartedAt: sql`now() - interval '61 minutes'` })
      .where(eq(bookingRateLimit.key, old));

    await pruneSubmissions();

    expect(await rowOf(old)).toBeUndefined();
    expect(await rowOf(recent)).toBeDefined();
  });
});

describe("who can see it", () => {
  it("is out of reach inside a tenant", async () => {
    const key = newKey();
    await spendSubmission(key);
    const { getDb } = await import("@/db");

    const seen = await getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.restaurant_id', ${crypto.randomUUID()}, true)`);
      return tx.select().from(bookingRateLimit).where(eq(bookingRateLimit.key, key));
    });

    expect(seen).toEqual([]);
  });
});
