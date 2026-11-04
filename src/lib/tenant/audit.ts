import "server-only";
import { auditLog } from "@/db/schema";
import type { TenantContext, TenantTransaction } from "./index";

/**
 * Writes one audit_log entry inside a withTenant() transaction, so the entry
 * commits or rolls back with the change it records (spec 01, Audit log).
 *
 * The restaurant and, by default, the actor come from the tenant context, never
 * from request input. A platform admin acting inside a tenant passes `actor`
 * (spec 01 requires actor_type = platform_admin); the system actor has no id.
 * A write for another restaurant than the transaction's is rejected by RLS.
 *
 * A platform admin's `actor.id` is always platform_admins.id, never a shadow
 * staff id (S-29). Its actions outside any tenant don't come through here: no
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
  /** Defaults to the signed-in staff member. */
  actor?: AuditActor;
};

export async function recordAudit(
  tx: TenantTransaction,
  ctx: Pick<TenantContext, "restaurantId" | "staffId">,
  entry: AuditEntry,
): Promise<void> {
  const actor = entry.actor ?? { type: "staff", id: ctx.staffId };
  await tx.insert(auditLog).values({
    restaurantId: ctx.restaurantId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    details: entry.details ?? {},
  });
}
