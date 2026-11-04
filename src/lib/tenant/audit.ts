import "server-only";
import { auditLog } from "@/db/schema";
import type { TenantContext, TenantTransaction } from "./index";

/**
 * Writes one audit_log entry inside a withTenant() transaction, so the entry
 * commits or rolls back with the change it records (spec 01, Audit log).
 *
 * The restaurant and, by default, the actor come from the tenant context, never
 * from request input: a platform admin who has entered a restaurant is recorded
 * as one (spec 01), by platform_admins.id and never the shadow staff id (S-29).
 * The system actor has no id, and is passed as `actor`. A write for another
 * restaurant than the transaction's is rejected by RLS.
 *
 * A platform admin's actions outside any tenant don't come through here: no
 * tenant is set, so app_tenant can't insert, and the privileged functions write
 * their own entries (S-28).
 */
export type AuditActor =
  | { type: "staff" | "platform_admin"; id: string }
  | { type: "system"; id?: null };

export type AuditEntry = {
  /** Dotted verb, e.g. 'staff.deactivate', 'booking.cancel'. */
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
  /** Defaults to whoever the context says is acting. */
  actor?: AuditActor;
};

/** Who a tenant context says is acting, for whoever writes the entry. */
export type Acting = Pick<
  TenantContext,
  "restaurantId" | "staffId" | "platformAdminId"
>;

async function insertEntry(
  tx: TenantTransaction,
  restaurantId: string,
  actor: AuditActor,
  entry: AuditEntry,
) {
  await tx.insert(auditLog).values({
    restaurantId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details ?? {},
  });
}

export async function recordAudit(
  tx: TenantTransaction,
  ctx: Acting,
  entry: AuditEntry,
): Promise<void> {
  const actor: AuditActor =
    entry.actor ??
    (ctx.platformAdminId
      ? { type: "platform_admin", id: ctx.platformAdminId }
      : { type: "staff", id: ctx.staffId });
  await insertEntry(tx, ctx.restaurantId, actor, entry);
}

/**
 * For a change spec 01's audit list leaves out when staff make it, like a
 * settings edit. The same list doesn't excuse a platform admin: every action
 * they take inside a tenant is audited, so call this from those writes.
 */
export async function recordAdminAction(
  tx: TenantTransaction,
  ctx: Pick<Acting, "restaurantId" | "platformAdminId">,
  entry: Omit<AuditEntry, "actor">,
): Promise<void> {
  if (!ctx.platformAdminId) return;
  const actor = { type: "platform_admin", id: ctx.platformAdminId } as const;
  await insertEntry(tx, ctx.restaurantId, actor, entry);
}
