import "server-only";
import { eq, sql } from "drizzle-orm";
import { adminAuthCodeLimit, staffAuthCodeLimit } from "@/db/schema";
import { CODE_WINDOW } from "./code-window";
import { authDatabase } from "./database";
import type { Audience } from "./index";

/**
 * The ceiling on sign-in codes, per email (S-30). Each code sent and each code
 * tried spends one attempt, up front, so a burst of parallel guesses can't get
 * past a check that hasn't been written down yet. A code that works gives them
 * all back. Kept in Postgres: memory would be per-instance on Vercel.
 */
export const CODE_ATTEMPTS_PER_WINDOW = 20;
const WINDOW = CODE_WINDOW;

/** How the sign-in form tells this apart from the per-IP limiter's 429. */
export const SIGN_IN_CODES_PAUSED = "sign_in_codes_paused";

const tables = { staff: staffAuthCodeLimit, admin: adminAuthCodeLimit };

/** Whether this email may have another attempt. `email` is already lowercased. */
export async function spendCodeAttempt(audience: Audience, email: string) {
  const table = tables[audience];
  const windowIsOver = sql`${table.windowStartedAt} <= now() - ${WINDOW}::interval`;
  const [{ attempts }] = await authDatabase(audience)
    .insert(table)
    .values({ email, attempts: 1, windowStartedAt: sql`now()` })
    .onConflictDoUpdate({
      target: table.email,
      set: {
        attempts: sql`case when ${windowIsOver} then 1 else ${table.attempts} + 1 end`,
        windowStartedAt: sql`case when ${windowIsOver} then now() else ${table.windowStartedAt} end`,
      },
    })
    .returning({ attempts: table.attempts });
  return attempts <= CODE_ATTEMPTS_PER_WINDOW;
}

export async function clearCodeAttempts(audience: Audience, email: string) {
  const table = tables[audience];
  await authDatabase(audience).delete(table).where(eq(table.email, email));
}
