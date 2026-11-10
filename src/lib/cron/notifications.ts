import "server-only";
import { and, asc, count, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { notifications, notificationSends } from "@/db/schema";
import type { SenderChoice, SendResult } from "@/lib/whatsapp/sender";
import { bookingConfirmed, type TemplateMessage } from "@/lib/whatsapp/templates";

/**
 * Spec 05's outbox, run by the scheduled job (S-35) as app_system. Claim, then
 * send: one short transaction moves due rows from pending to sending, with
 * claimed_at = now(), selecting them FOR UPDATE SKIP LOCKED, and commits; only
 * then is each claimed row sent and marked sent with Meta's message id. Two runs
 * at once claim different rows, so no row is sent twice.
 *
 * Before each send the booking is read again, through notification_sends, the
 * one place app_system may read a guest's details, and only for a row it has
 * claimed (migration 0034). A booking_confirmed whose booking is no longer
 * confirmed, or whose guest has no number or no opt-in now, is marked cancelled
 * without sending. A failed send is marked failed with its error; retrying it,
 * and returning rows stuck in sending, are #47's.
 *
 * In production without WhatsApp's keys (`hold`) nothing is claimed: due rows
 * wait as pending and go on the first run after the keys are set.
 *
 * Every write names the row by (restaurant_id, id) and requires the status it
 * expects, so a repeat or an overlapping run changes nothing a second time.
 * `now` decides what is due, so a test can pick the moment.
 */

/** Small batches: a claimed row is sent within seconds of its claim. */
const BATCH_SIZE = 20;
/** At most 100 sends a run, well inside the function's time limit (S-35); the next run takes the rest. */
const MAX_BATCHES = 5;

/** The kinds this task can send, and the booking status each needs at send time. */
const sendable = {
  booking_confirmed: "confirmed",
} as const;
const sendableKinds = Object.keys(sendable) as (keyof typeof sendable)[];

type Claimed = { restaurantId: string; id: string };

export async function sendDueNotifications(db: Database, now: Date, choice: SenderChoice): Promise<number> {
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

  let finished = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const claimed = await claim(db, due);
    for (const row of claimed) {
      if (await sendOne(db, row, choice.sender.send.bind(choice.sender))) finished++;
    }
    if (claimed.length < BATCH_SIZE) break;
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
  if (!found.restaurantPhone) {
    return finish(db, row, { status: "failed", lastError: "The restaurant has no contact phone for {{6}}." });
  }

  const message = bookingConfirmed({ ...found, guestPhone: found.guestPhone, restaurantPhone: found.restaurantPhone });
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
