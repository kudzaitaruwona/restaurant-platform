import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { notifications } from "@/db/schema";
import type { DeliveryStatus, DeliveryStatusName } from "./webhook";

/**
 * Meta's delivery statuses written to the outbox (spec 05, Delivery status), on
 * the system login the webhook's route hands over: it works across every
 * restaurant, since a callback names only Meta's message id. Each status finds
 * its row by provider_message_id, then writes it keyed by (restaurant_id, id),
 * as everything acting on one booking's row does (spec 01, system routes).
 *
 * Meta doesn't promise order, and retries a callback it thinks failed, so a
 * status only moves forward (S-37 in detail, #48):
 * - `delivered` and `read` replace `sent` and `failed`, and `read` replaces
 *   `delivered`: proof the guest got the message beats an earlier failure.
 * - `failed` replaces only `sent`: once delivered, a failure is stale.
 * - `sent` changes nothing: a row has a message id only once the job has
 *   marked it sent, so it is already there or further on.
 * A row in `pending`, `sending` or `cancelled` is never touched. The same
 * status twice is a no-op, so a retried callback is harmless.
 */
const movesFrom: Record<DeliveryStatusName, (typeof notifications.$inferSelect)["status"][]> = {
  sent: [],
  delivered: ["sent", "failed"],
  read: ["sent", "delivered", "failed"],
  failed: ["sent"],
};

/** Applies each status in the order given; returns how many rows changed. */
export async function applyDeliveryStatuses(db: Database, statuses: readonly DeliveryStatus[]) {
  let changed = 0;
  for (const { providerMessageId, status, error } of statuses) {
    const from = movesFrom[status];
    if (from.length === 0) continue;
    const rows = await db
      .select({ restaurantId: notifications.restaurantId, id: notifications.id })
      .from(notifications)
      .where(eq(notifications.providerMessageId, providerMessageId));
    for (const { restaurantId, id } of rows) {
      const { rowCount } = await db
        .update(notifications)
        .set(status === "failed" ? { status, lastError: error ?? null } : { status })
        .where(
          and(
            eq(notifications.restaurantId, restaurantId),
            eq(notifications.id, id),
            eq(notifications.providerMessageId, providerMessageId),
            inArray(notifications.status, from),
          ),
        );
      changed += rowCount ?? 0;
    }
  }
  return changed;
}
