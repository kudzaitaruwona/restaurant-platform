import "server-only";
import { lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { adminAuthCodeLimit, staffAuthCodeLimit } from "@/db/schema";
import { CODE_WINDOW } from "@/lib/auth/code-window";

/**
 * S-30's retention, run by the scheduled job (S-35): a sign-in code row whose
 * 24-hour window is over has no further use, because the next attempt starts a
 * fresh window, and the rows hold whatever address anyone typed. "Over" is the
 * same test the ceiling itself applies (src/lib/auth/code-limit.ts). Idempotent:
 * a row deleted twice is deleted once, and a sign-in racing this either finds
 * no row and starts one, or finds it and starts its window again.
 */
export async function pruneCodeLimits(db: Database, now: Date): Promise<number> {
  const before = sql`${now.toISOString()}::timestamptz - ${CODE_WINDOW}::interval`;
  let pruned = 0;
  for (const table of [staffAuthCodeLimit, adminAuthCodeLimit]) {
    const { rowCount } = await db.delete(table).where(lte(table.windowStartedAt, before));
    pruned += rowCount ?? 0;
  }
  return pruned;
}
