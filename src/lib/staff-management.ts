import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { restaurants, staff, staffInvites, staffRole } from "@/db/schema";
import { APP_NAME, staffInviteEmail } from "@/lib/auth/email";
import {
  appUrl,
  deliverInvite,
  type ResendOutcome,
  sqlStateOf,
  TOO_MANY_INVITES,
} from "@/lib/invites";
import { type TenantContext, type TenantTransaction, withTenant } from "@/lib/tenant";
import { type Acting, recordAudit } from "@/lib/tenant/audit";

export { INVITES_PER_HOUR } from "@/lib/invites";

/**
 * Staff management, owner only (S-26): callers check requireOwner(ctx). Only
 * kind = 'staff' rows are managed here. A platform_admin shadow row belongs to
 * the platform, so to an owner it doesn't exist.
 *
 * The last-owner rule lives in a trigger on staff (see the migration). The
 * functions here just report it: the refused change rolls back with its audit
 * entry.
 */

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

const managed = (ctx: Acting, staffId: string) =>
  and(
    eq(staff.restaurantId, ctx.restaurantId),
    eq(staff.id, staffId),
    eq(staff.kind, "staff"),
  );

/**
 * The team, with whether each person has joined (signed in at least once) and
 * their latest invite, for Invited or Joined (S-42).
 */
export async function listStaff(ctx: Pick<Acting, "restaurantId">) {
  return withTenant(ctx, async (tx) => {
    const [team, invites] = await Promise.all([
      tx
        .select({
          id: staff.id,
          email: staff.email,
          displayName: staff.displayName,
          role: staff.role,
          active: staff.active,
          firstSignedInAt: staff.firstSignedInAt,
        })
        .from(staff)
        .where(and(eq(staff.restaurantId, ctx.restaurantId), eq(staff.kind, "staff")))
        .orderBy(asc(staff.createdAt), asc(staff.id)),
      tx
        .selectDistinctOn([staffInvites.staffId], {
          staffId: staffInvites.staffId,
          sentAt: staffInvites.sentAt,
          delivered: staffInvites.delivered,
        })
        .from(staffInvites)
        .where(eq(staffInvites.restaurantId, ctx.restaurantId))
        .orderBy(staffInvites.staffId, desc(staffInvites.sentAt)),
    ]);
    const latest = new Map(invites.map(({ staffId, ...invite }) => [staffId, invite]));
    return team.map((member) => ({ ...member, invite: latest.get(member.id) ?? null }));
  });
}

/** What the soft limit counts, given listStaff(): shadow rows are already out. */
export const countOwnerLogins = (team: Awaited<ReturnType<typeof listStaff>>) =>
  team.filter((member) => member.active && member.role === "owner").length;

/**
 * A restaurant's first staff record is its owner (S-26). Only a platform admin
 * who has entered can get here with no owner yet. Once there is one, the
 * last-owner trigger keeps it, so asking first leaves nothing to race.
 */
export async function addStaff(
  ctx: Acting,
  person: NewStaff,
): Promise<"added" | "email_taken" | "needs_owner_first"> {
  let added: Awaited<ReturnType<typeof startInvite>> | undefined;
  try {
    const outcome = await withTenant(ctx, async (tx) => {
      if (person.role !== "owner") {
        const [owner] = await tx
          .select({ id: staff.id })
          .from(staff)
          .where(
            and(
              eq(staff.restaurantId, ctx.restaurantId),
              eq(staff.kind, "staff"),
              eq(staff.role, "owner"),
              eq(staff.active, true),
            ),
          )
          .limit(1);
        if (!owner) return "needs_owner_first";
      }

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
      added = await startInvite(tx, ctx, created.id);
      return "added";
    });
    // After the commit: the person stays whatever the email does (S-42).
    if (added) await sendInvite(ctx, added);
    return outcome;
  } catch (error) {
    const constraint = constraintOf(error);
    // An exact match can trip the first, a match in another case only the second.
    if (constraint === "staff_email_unique" || constraint === "staff_email_lower_unique") {
      return "email_taken";
    }
    throw error;
  }
}

export async function deactivateStaff(ctx: Acting, staffId: string) {
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

export async function changeStaffRole(ctx: Acting, staffId: string, to: Role) {
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

/**
 * Records an invite to someone in the transaction, which Postgres refuses past
 * the hourly limit, and gathers what the email says. Who added them is the
 * person acting, by the name their colleagues know; an entered platform admin
 * is the platform, not the shadow row's "Platform admin".
 */
async function startInvite(tx: TenantTransaction, ctx: Acting, staffId: string) {
  const [invite] = await tx
    .insert(staffInvites)
    .values({ restaurantId: ctx.restaurantId, staffId })
    .returning({ id: staffInvites.id });
  const [person] = await tx
    .select({
      email: staff.email,
      name: staff.displayName,
      role: staff.role,
      restaurantName: restaurants.name,
    })
    .from(staff)
    .innerJoin(restaurants, eq(restaurants.id, staff.restaurantId))
    .where(and(eq(staff.restaurantId, ctx.restaurantId), eq(staff.id, staffId)));
  let addedBy = `The ${APP_NAME} team`;
  if (!ctx.platformAdminId) {
    const [actor] = await tx
      .select({ name: staff.displayName })
      .from(staff)
      .where(and(eq(staff.restaurantId, ctx.restaurantId), eq(staff.id, ctx.staffId)));
    if (actor) addedBy = actor.name;
  }
  return { inviteId: invite.id, ...person, email: person.email!, addedBy };
}

/** Sends a recorded invite, outside any transaction, and records how it went. */
async function sendInvite(
  ctx: Pick<Acting, "restaurantId">,
  invite: Awaited<ReturnType<typeof startInvite>>,
) {
  const delivered = await deliverInvite(
    staffInviteEmail({
      to: invite.email,
      name: invite.name,
      restaurantName: invite.restaurantName,
      addedBy: invite.addedBy,
      role: invite.role,
      appUrl: appUrl(),
    }),
  );
  // The person is already saved: failing to note how the email went must not
  // turn that into an error. The row stays "not known", shown as not delivered.
  await withTenant(ctx, (tx) =>
    tx
      .update(staffInvites)
      .set({ delivered })
      .where(
        and(eq(staffInvites.restaurantId, ctx.restaurantId), eq(staffInvites.id, invite.inviteId)),
      ),
  ).catch((error: unknown) => {
    console.error("Couldn't record how an invite went (S-42):", error instanceof Error ? error.message : error);
  });
  return delivered;
}

/**
 * "Send invite again" (S-42), for an active colleague who hasn't signed in yet.
 * Audited, by whoever asked. Postgres refuses more than INVITES_PER_HOUR to one
 * person in an hour, the first included.
 */
export async function resendInvite(ctx: Acting, staffId: string): Promise<ResendOutcome> {
  let invite: Awaited<ReturnType<typeof startInvite>> | undefined;
  try {
    const refused = await withTenant(ctx, async (tx) => {
      const [member] = await tx
        .select({ joined: staff.firstSignedInAt })
        .from(staff)
        .where(and(managed(ctx, staffId), eq(staff.active, true)))
        .for("no key update");
      if (!member) return "not_found" as const;
      if (member.joined) return "joined" as const;

      invite = await startInvite(tx, ctx, staffId);
      await recordAudit(tx, ctx, {
        action: "staff.invite_resend",
        entityType: "staff",
        entityId: staffId,
      });
      return undefined;
    });
    if (refused) return refused;
  } catch (error) {
    if (sqlStateOf(error) === TOO_MANY_INVITES) return "too_many";
    throw error;
  }
  return (await sendInvite(ctx, invite!)) ? "sent" : "not_sent";
}
