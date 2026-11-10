import "server-only";
import { and, asc, count, eq, inArray, lte, sql } from "drizzle-orm";
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
 * without sending. A failed send is marked failed with its error; retrying it,
 * and returning rows stuck in sending, are #47's.
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

/** The kinds this task can send, and the booking status each needs at send time. */
const sendable = {
  booking_confirmed: "confirmed",
  booking_reminder: "confirmed",
} as const;
const sendableKinds = Object.keys(sendable) as (keyof typeof sendable)[];

type Claimed = { restaurantId: string; id: string };

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
    // taken it: that is #47's to recover, never this run's to send again.
    let started = 0;
    try {
      while (started < claimed.length && !outOfTime()) {
        if (await sendOne(db, claimed[started++], send)) finished++;
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
      .returning({ id: notifications.id });
    // RETURNING has no order: send the earliest due first, as selected.
    const ids = new Set(updated.map(({ id }) => id));
    return rows.filter(({ id }) => ids.has(id));
  });
}

/**
 * sending -> pending for rows this run claimed and never started to send. The
 * claim's attempt is given back, since no send was tried, and claimed_at
 * cleared. Only this run's own claimed rows, by (restaurant_id, id), and only
 * while still in sending: a row anything else has moved since is left alone.
 */
async function release(db: Database, rows: Claimed[]) {
  if (rows.length === 0) return;
  await db
    .update(notifications)
    .set({ status: "pending", claimedAt: null, attempts: sql`${notifications.attempts} - 1` })
    .where(and(eq(notifications.status, "sending"), byKeys(rows)));
}

const byKeys = (rows: Claimed[]) =>
  sql`(${notifications.restaurantId}, ${notifications.id}) in (${sql.join(
    rows.map(({ restaurantId, id }) => sql`(${restaurantId}::uuid, ${id}::uuid)`),
    sql`, `,
  )})`;

/**
 * Re-checks one claimed row's booking, then sends it or says why not. Read here,
 * just before its own send, not once for the batch: a guest who cancels while the
 * batch's earlier messages are going out gets no confirmation.
 */
async function sendOne(db: Database, row: Claimed, send: (message: TemplateMessage) => Promise<SendResult>) {
  const [found] = await db
    .select()
    .from(notificationSends)
    .where(and(eq(notificationSends.restaurantId, row.restaurantId), eq(notificationSends.id, row.id)));
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
    result = { ok: false, error: `Sender failed: ${error instanceof Error ? error.name : "unknown"}` };
  }
  return finish(
    db,
    row,
    result.ok
      ? { status: "sent", providerMessageId: result.providerMessageId }
      : { status: "failed", lastError: result.error },
  );
}

async function finish(
  db: Database,
  { restaurantId, id }: Claimed,
  change: { status: "sent" | "failed" | "cancelled"; providerMessageId?: string; lastError?: string },
) {
  const { rowCount } = await db
    .update(notifications)
    .set(change)
    .where(
      and(
        eq(notifications.restaurantId, restaurantId),
        eq(notifications.id, id),
        eq(notifications.status, "sending"),
      ),
    );
  return (rowCount ?? 0) > 0;
}
