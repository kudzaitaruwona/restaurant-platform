import "server-only";
import type { Database } from "@/db/client";
import { completeOverdueSittings, markNoShows } from "./booking-status";
import { getEnv } from "@/lib/env";
import { chooseSender } from "@/lib/whatsapp/sender";
import { pruneCodeLimits } from "./code-limits";
import { closeIdleSessions } from "./idle-expiry";
import { sendDueNotifications } from "./notifications";
import { purgeGuestPhones } from "./phone-purge";

/**
 * One run of the 5-minute scheduled job (S-35): every task specs 04, 05 and 06
 * put on it, in order, on the system login the route hands over, QR idle
 * expiry last, in the place S-35 gives it. Each must be idempotent and safe to overlap
 * with itself: Vercel can deliver a run twice and doesn't retry a failed one.
 */
export type TickTask = {
  name: string;
  /**
   * Does its work as of `now`; returns how many rows it changed. The outbox
   * counts the notifications it finished: sent, failed or cancelled.
   */
  run: (db: Database, now: Date) => Promise<number>;
};

export const tickTasks: readonly TickTask[] = [
  { name: "noShows", run: markNoShows },
  { name: "completed", run: completeOverdueSittings },
  // After the status rules, so a booking they have just closed gets no confirmation.
  // The sender is chosen per run from the environment: Meta, the console, or hold.
  {
    name: "notifications",
    run: (db, now) => sendDueNotifications(db, now, chooseSender(getEnv())),
  },
  { name: "phonesPurged", run: purgeGuestPhones },
  { name: "codeLimitsPruned", run: pruneCodeLimits },
  // Spec 06's QR idle expiry, last, where S-35 puts it.
  { name: "idleSessionsClosed", run: (db, now) => closeIdleSessions(db, now) },
];

export type TickResult = { ok: boolean; tasks: Record<string, number | "failed"> };

/**
 * Runs each task in turn. One that fails doesn't stop the rest, because they
 * don't depend on each other and a lost run of one shouldn't cost the others
 * (the next run, 5 minutes later, covers it). A failure is logged by its code
 * only: a database error's message quotes the statement's parameters.
 */
export async function runTick(
  db: Database,
  now: Date,
  tasks: readonly TickTask[] = tickTasks,
): Promise<TickResult> {
  const result: TickResult = { ok: true, tasks: {} };
  for (const { name, run } of tasks) {
    try {
      result.tasks[name] = await run(db, now);
    } catch (error) {
      result.ok = false;
      result.tasks[name] = "failed";
      console.error(`Scheduled job: ${name} failed (${errorCode(error)}).`);
    }
  }
  return result;
}

function errorCode(error: unknown) {
  const { cause } = (error ?? {}) as { cause?: { code?: unknown } };
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : error instanceof Error ? error.name : "unknown";
}
