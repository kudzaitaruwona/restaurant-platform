import "server-only";
import { and, asc, count, eq, exists, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { notifications, notificationSends } from "@/db/schema";
import type { SenderChoice, SendResult } from "@/lib/whatsapp/sender";
import { bookingConfirmed, bookingReminder, type TemplateMessage } from "@/lib/whatsapp/templates";

/**
 * Spec 05's outbox, run by the scheduled job (S-35) as app_system. Claim, then
 * send: one short transaction moves due rows from pending to sending, with
 * claimed_at = now(), selecting them FOR UPDATE SKIP LOCKED, and commits; only
 * then is each claimed row sent and marked sent with Meta's message id. Two runs
 * at once claim different rows, so no row is sent twice.
 *
 * Before each send the booking is read again, through notification_sends, the
 * one place app_system may read a guest's details, and only for a row it has
 * claimed (migration 0034). A booking_confirmed or booking_reminder whose booking is no longer
 * confirmed, or whose guest has no number or no opt-in now, is marked cancelled
 * without sending.
 *
 * Retry (#47): a send that may work later (SendResult.retryable: a network
 * error, a timeout, a rate limit, a 5xx) goes back to pending with its error,
 * due again 5 minutes later, then 10; the third failed attempt marks it failed.
 * A send refused for good (an invalid number, say) is failed at once.
 * `attempts` counts sends tried: the claim adds one.
 *
 * Delivery is AT LEAST ONCE, by design (spec 05). A run that dies after Meta
 * has taken a message but before it is marked sent leaves the row in sending.
 * Each run first returns rows stuck in sending for over 10 minutes to pending
 * (or failed, if that was their third attempt), and they are sent again, so the
 * guest may get the message twice. A rare duplicate is accepted over a lost
 * reminder. A timeout is retried for the same reason: Meta may have taken it.
 *
 * Recovery never races a live run: a run sends nothing past its time budget
 * (below), 75 seconds plus one 10-second send, and the function is stopped at
 * 300, both far inside the 10 minutes. And in case one is somehow alive that
 * long, every step after a claim names the claim (claimed_at = the run's own):
 * once its row is recovered, that run can't read the guest's details, send, or
 * write the row over, whatever a later run has done with it. The only window
 * left is a send already in flight, which is a duplicate at worst.
 *
 * In production without WhatsApp's keys (`hold`) nothing is claimed: due rows
 * wait as pending and go on the first run after the keys are set.
 *
 * A run has a time budget, so a slow or silent Meta can't hold the job past
 * its function's 300-second limit and starve the tasks after this one. The
 * deadline is checked before each claim and each send; once it passes, the
 * rows this run claimed but hasn't started are put back to pending for the
 * next run. Worst case: the budget plus one send's 10-second timeout.
 *
 * Every write names the row by (restaurant_id, id) and requires the status it
 * expects, so a repeat or an overlapping run changes nothing a second time.
 * `now` decides what is due, so a test can pick the moment; the budget runs on
 * the real clock.
 */

/** Small batches: a claimed row is sent within seconds of its claim. */
const BATCH_SIZE = 20;
/** At most 100 sends a run; the next run takes the rest. */
const MAX_BATCHES = 5;
/** 75 seconds of a 300-second function (S-37 in detail): room for the tasks after this one. */
const TIME_BUDGET_MS = 75_000;

/** Sends tried before a row is failed: the first and two retries. */
const MAX_ATTEMPTS = 3;
/** Minutes before the retry after attempt n: 5, then 10. Runs are 5 minutes apart. */
const retryDelayMinutes = (attempts: number) => 5 * 2 ** (attempts - 1);
/** A row in sending this long was claimed by a run that has died (spec 05). */
const STUCK_AFTER = sql`interval '10 minutes'`;
/** Stuck rows recovered per run; a crash strands at most one batch, so this is plenty. */
const MAX_RECOVERED = BATCH_SIZE * MAX_BATCHES;

/** The kinds this task can send, and the booking status each needs at send time. */
const sendable = {
  booking_confirmed: "confirmed",
  booking_reminder: "confirmed",
} as const;
const sendableKinds = Object.keys(sendable) as (keyof typeof sendable)[];

/**
 * A row this run claimed. claimedAt is the claim's own timestamp, as Postgres's
 * text (a JS Date would drop its microseconds): every later step requires it.
 */
type Claimed = { restaurantId: string; id: string; claimedAt: string; attempts: number };

export async function sendDueNotifications(
  db: Database,
  now: Date,
  choice: SenderChoice,
  { budgetMs = TIME_BUDGET_MS }: { budgetMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const outOfTime = () => Date.now() >= deadline;

  const due = and(
    eq(notifications.status, "pending"),
    inArray(notifications.kind, sendableKinds),
    lte(notifications.scheduledFor, now),
  )!;

  // Even while holding: a stuck row goes back to pending, to wait with the rest.
  await recover(db);

  if (choice.kind === "hold") {
    const [{ held }] = await db.select({ held: count() }).from(notifications).where(due);
    if (held > 0) {
      console.warn(
        `Scheduled job: holding ${held} due WhatsApp ${held === 1 ? "message" : "messages"} as pending: ${choice.missing.join(" and ")} not set.`,
      );
    }
    return 0;
  }

  const send = choice.sender.send.bind(choice.sender);
  let finished = 0;
  for (let batch = 0; batch < MAX_BATCHES && !outOfTime(); batch++) {
    const claimed = await claim(db, due);
    // Rows before `started` have begun their send; the rest haven't. Whatever
    // ends the batch (the deadline or an error), the ones not started go back
    // to pending. One whose send began stays in sending, since Meta may have
    // taken it: recover() returns it after 10 minutes, never this run.
    let started = 0;
    try {
      while (started < claimed.length && !outOfTime()) {
        if (await sendOne(db, claimed[started++], send, now)) finished++;
      }
    } finally {
      await release(db, claimed.slice(started));
    }
    if (started < claimed.length || claimed.length < BATCH_SIZE) break;
  }
  return finished;
}

/** pending -> sending, in a transaction of its own that commits before any send. */
function claim(db: Database, due: ReturnType<typeof and>): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ restaurantId: notifications.restaurantId, id: notifications.id })
      .from(notifications)
      .where(due)
      .orderBy(asc(notifications.scheduledFor))
      .limit(BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return [];
    const updated = await tx
      .update(notifications)
      .set({ status: "sending", claimedAt: sql`now()`, attempts: sql`${notifications.attempts} + 1` })
      .where(and(eq(notifications.status, "pending"), byKeys(rows)))
      .returning({
        id: notifications.id,
        claimedAt: sql<string>`${notifications.claimedAt}::text`,
        attempts: notifications.attempts,
      });
    // RETURNING has no order: send the earliest due first, as selected.
    const claims = new Map(updated.map(({ id, ...claim }) => [id, claim]));
    return rows.flatMap((row) => {
      const claim = claims.get(row.id);
      return claim ? [{ ...row, ...claim }] : [];
    });
  });
}

/**
 * sending -> pending for rows this run claimed and never started to send. The
 * claim's attempt is given back, since no send was tried, and claimed_at
 * cleared. Only this run's own claims, by claimed_at as ownClaim: a row anything else has moved
 * since, or recovered and claimed again, is left alone.
 */
async function release(db: Database, rows: Claimed[]) {
  if (rows.length === 0) return;
  await db
    .update(notifications)
    .set({ status: "pending", claimedAt: null, attempts: sql`${notifications.attempts} - 1` })
    .where(
      and(
        eq(notifications.status, "sending"),
        sql`(${notifications.restaurantId}, ${notifications.id}, ${notifications.claimedAt}) in (${sql.join(
          rows.map(({ restaurantId, id, claimedAt }) => sql`(${restaurantId}::uuid, ${id}::uuid, ${claimedAt}::timestamptz)`),
          sql`, `,
        )})`,
      ),
    );
}

/**
 * sending -> pending for rows claimed over 10 minutes ago by a run that has
 * since died (spec 05's crash recovery): the attempt stays counted, since the
 * send may have gone. One on its last attempt is failed instead, so a row that
 * kills every run that sends it can't loop forever. Selected FOR UPDATE SKIP
 * LOCKED and written by (restaurant_id, id), still stuck, like the claim.
 */
function recover(db: Database) {
  const stuck = and(
    eq(notifications.status, "sending"),
    lt(notifications.claimedAt, sql`now() - ${STUCK_AFTER}`),
  )!;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ restaurantId: notifications.restaurantId, id: notifications.id })
      .from(notifications)
      .where(stuck)
      .limit(MAX_RECOVERED)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return;
    const lastAttempt = sql`${notifications.attempts} >= ${MAX_ATTEMPTS}`;
    await tx
      .update(notifications)
      .set({
        status: sql`case when ${lastAttempt} then 'failed' else 'pending' end::notification_status`,
        claimedAt: sql`case when ${lastAttempt} then ${notifications.claimedAt} end`,
        lastError: sql`case when ${lastAttempt}
          then 'Stuck in sending for over 10 minutes on its last attempt; Meta may have taken it.'
          else 'Stuck in sending for over 10 minutes; returned to pending, so the guest may get it twice.' end`,
      })
      .where(and(stuck, byKeys(rows)));
  });
}

const byKeys = (rows: Pick<Claimed, "restaurantId" | "id">[]) =>
  sql`(${notifications.restaurantId}, ${notifications.id}) in (${sql.join(
    rows.map(({ restaurantId, id }) => sql`(${restaurantId}::uuid, ${id}::uuid)`),
    sql`, `,
  )})`;

/**
 * Re-checks one claimed row's booking, then sends it or says why not. Read here,
 * just before its own send, not once for the batch: a guest who cancels while the
 * batch's earlier messages are going out gets no confirmation.
 */
async function sendOne(
  db: Database,
  row: Claimed,
  send: (message: TemplateMessage) => Promise<SendResult>,
  now: Date,
) {
  // Only while the claim is still this run's: never a row recovered from it.
  const [found] = await db
    .select()
    .from(notificationSends)
    .where(
      and(
        eq(notificationSends.restaurantId, row.restaurantId),
        eq(notificationSends.id, row.id),
        exists(db.select({ one: sql`1` }).from(notifications).where(ownClaim(row))),
      ),
    );
  if (!found) return false;

  if (found.bookingStatus !== sendable[found.kind as keyof typeof sendable] || !found.whatsappOptIn || !found.guestPhone) {
    return finish(db, row, { status: "cancelled" });
  }
  // Only the confirmation names the restaurant's phone ({{6}}); the reminder doesn't.
  if (found.kind === "booking_confirmed" && !found.restaurantPhone) {
    return finish(db, row, { status: "failed", lastError: "The restaurant has no contact phone for {{6}}." });
  }

  const guest = { ...found, guestPhone: found.guestPhone, restaurantPhone: found.restaurantPhone ?? "" };
  const message = found.kind === "booking_reminder" ? bookingReminder(guest) : bookingConfirmed(guest);
  let result: SendResult;
  try {
    result = await send(message);
  } catch (error) {
    // The sender broke its never-throws promise: it can't say whether the message went.
    result = { ok: false, error: `Sender failed: ${error instanceof Error ? error.name : "unknown"}`, retryable: true };
  }
  if (result.ok) return finish(db, row, { status: "sent", providerMessageId: result.providerMessageId });
  if (result.retryable && row.attempts < MAX_ATTEMPTS) {
    const retryAt = new Date(now.getTime() + retryDelayMinutes(row.attempts) * 60_000);
    await finish(db, row, { status: "pending", claimedAt: null, scheduledFor: retryAt, lastError: result.error });
    // Not finished: it goes again.
    return false;
  }
  return finish(db, row, { status: "failed", lastError: result.error });
}

async function finish(
  db: Database,
  row: Claimed,
  change: Partial<Pick<typeof notifications.$inferInsert, "providerMessageId" | "lastError" | "claimedAt" | "scheduledFor">> & {
    status: "sent" | "failed" | "cancelled" | "pending";
  },
) {
  const { rowCount } = await db.update(notifications).set(change).where(ownClaim(row));
  return (rowCount ?? 0) > 0;
}

/** The row, by (restaurant_id, id), still in sending under this very claim. */
const ownClaim = ({ restaurantId, id, claimedAt }: Claimed) =>
  and(
    eq(notifications.restaurantId, restaurantId),
    eq(notifications.id, id),
    eq(notifications.status, "sending"),
    sql`${notifications.claimedAt} = ${claimedAt}::timestamptz`,
  );
