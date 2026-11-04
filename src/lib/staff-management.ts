import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { staff, staffRole } from "@/db/schema";
import { type TenantContext, withTenant } from "@/lib/tenant";
import { recordAudit } from "@/lib/tenant/audit";

/**
 * Staff management, owner only (S-26): callers check requireOwner(ctx). Only
 * kind = 'staff' rows are managed here. A platform_admin shadow row belongs to
 * the platform, so to an owner it doesn't exist.
 *
 * The last-owner rule lives in a trigger on staff (see the migration). The
 * functions here just report it: the refused change rolls back with its audit
 * entry.
 */

type Actor = Pick<TenantContext, "restaurantId" | "staffId">;
type Role = TenantContext["role"];
export type StaffChange = "done" | "not_found" | "last_owner";

/**
 * Spec 01: "one owner login on the standard plan". Pricing is undefined (D-08)
 * and the standard plan is the only one, so every restaurant gets this number.
 * It's a notice, never a block.
 */
export const OWNER_LOGIN_SOFT_LIMIT = 1;

const messages = {
  email: "Enter a valid email address.",
  displayName: "Enter a name, up to 200 characters.",
  role: "Choose owner or staff.",
};

const role = z.enum(staffRole.enumValues, messages.role);

const newStaffForm = z.object({
  // Lower case, so one inbox can't hold two logins under the unique index.
  email: z.string(messages.email).trim().toLowerCase().pipe(z.email(messages.email)),
  displayName: z
    .string(messages.displayName)
    .trim()
    .min(1, messages.displayName)
    .max(200, messages.displayName),
  role,
});

export type NewStaff = z.output<typeof newStaffForm>;

function parsed<T>(result: z.ZodSafeParseResult<T>) {
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
}

export const parseNewStaff = (form: FormData) =>
  parsed(newStaffForm.safeParse(Object.fromEntries(form)));

export const parseRole = (form: FormData) =>
  parsed(role.safeParse(form.get("role")));

const constraintOf = (error: unknown) =>
  (error as { cause?: { constraint?: unknown } } | null)?.cause?.constraint;

async function reportingLastOwner(change: () => Promise<StaffChange>) {
  try {
    return await change();
  } catch (error) {
    if (constraintOf(error) === "staff_last_active_owner") return "last_owner";
    throw error;
  }
}

const managed = (ctx: Actor, staffId: string) =>
  and(
    eq(staff.restaurantId, ctx.restaurantId),
    eq(staff.id, staffId),
    eq(staff.kind, "staff"),
  );

export async function listStaff(ctx: Pick<Actor, "restaurantId">) {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: staff.id,
        email: staff.email,
        displayName: staff.displayName,
        role: staff.role,
        active: staff.active,
      })
      .from(staff)
      .where(and(eq(staff.restaurantId, ctx.restaurantId), eq(staff.kind, "staff")))
      .orderBy(asc(staff.createdAt), asc(staff.id)),
  );
}

/** What the soft limit counts, given listStaff(): shadow rows are already out. */
export const countOwnerLogins = (team: Awaited<ReturnType<typeof listStaff>>) =>
  team.filter((member) => member.active && member.role === "owner").length;

export async function addStaff(
  ctx: Actor,
  person: NewStaff,
): Promise<"added" | "email_taken"> {
  try {
    await withTenant(ctx, async (tx) => {
      const [created] = await tx
        .insert(staff)
        .values({ ...person, restaurantId: ctx.restaurantId })
        .returning({ id: staff.id });
      await recordAudit(tx, ctx, {
        action: "staff.create",
        entityType: "staff",
        entityId: created.id,
        details: { role: person.role },
      });
    });
    return "added";
  } catch (error) {
    const constraint = constraintOf(error);
    // An exact match can trip the first, a match in another case only the second.
    if (constraint === "staff_email_unique" || constraint === "staff_email_lower_unique") {
      return "email_taken";
    }
    throw error;
  }
}

export async function deactivateStaff(ctx: Actor, staffId: string) {
  return reportingLastOwner(() =>
    withTenant(ctx, async (tx) => {
      const deactivated = await tx
        .update(staff)
        .set({ active: false })
        .where(and(managed(ctx, staffId), eq(staff.active, true)))
        .returning({ id: staff.id });
      if (deactivated.length === 0) return "not_found";

      await recordAudit(tx, ctx, {
        action: "staff.deactivate",
        entityType: "staff",
        entityId: staffId,
      });
      return "done";
    }),
  );
}

export async function changeStaffRole(ctx: Actor, staffId: string, to: Role) {
  return reportingLastOwner(() =>
    withTenant(ctx, async (tx) => {
      const [member] = await tx
        .select({ role: staff.role })
        .from(staff)
        .where(managed(ctx, staffId))
        .for("update");
      if (!member) return "not_found";
      if (member.role === to) return "done";

      await tx.update(staff).set({ role: to }).where(managed(ctx, staffId));
      await recordAudit(tx, ctx, {
        action: "staff.role_change",
        entityType: "staff",
        entityId: staffId,
        details: { from: member.role, to },
      });
      return "done";
    }),
  );
}
