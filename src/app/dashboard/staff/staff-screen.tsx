import { Mail, UserCog, UserX } from "lucide-react";
import { CsvImportDialog } from "@/components/csv-import-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { RowMenu, RowMenuItem, RowMenuSeparator } from "@/components/ui/row-menu";
import { inviteStatus } from "@/lib/invite-status";
import { getRestaurantSettings } from "@/lib/restaurant-settings";
import { STAFF_MAX_ROWS } from "@/lib/staff-import";
import {
  countOwnerLogins,
  listStaff,
  OWNER_LOGIN_SOFT_LIMIT,
} from "@/lib/staff-management";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { ActionForm } from "../action-form";
import { initialsOf } from "../shell/nav";
import { InviteStatusLabel } from "./invite-status";

/** The hidden forms take no room until one has a refusal (or a "sent") to show. */
const refusalSpace = "has-[[role=alert]]:mt-2 has-[[role=status]]:mt-2 sm:pl-[52px]";

/** Staff management: owner only (S-26). */
export async function StaffScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const [team, { timezone }] = await Promise.all([
    listStaff(tenant),
    getRestaurantSettings(tenant),
  ]);
  const ownerLogins = countOwnerLogins(team);
  const active = team.filter((member) => member.active).length;

  return (
    <div className="flex w-full max-w-5xl flex-col gap-6">
      <PageHeader
        title="Staff"
        subtitle={`${active} ${active === 1 ? "person" : "people"} can sign in. They sign in with their email address.`}
        actions={
          <CsvImportDialog
            kind="staff"
            action="/api/staff/import"
            title="Import staff"
            noun={{ one: "person", other: "people" }}
            maxRows={STAFF_MAX_ROWS}
            intro={
              <p>
                Columns: email, name and role (owner or staff, blank is staff). Each person is added
                as if by hand, and invited by email, so a file takes at most {STAFF_MAX_ROWS} people.
                Someone already on your staff is skipped.
              </p>
            }
          />
        }
      />

      {ownerLogins > OWNER_LOGIN_SOFT_LIMIT && (
        <Notice role="status">
          This restaurant has {ownerLogins} owner logins, more than the one included in the
          standard plan. Nothing is blocked.
        </Notice>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card as="section" aria-label="Team">
          <ul className="divide-y divide-line">
            {team.map((member) => {
              const you = member.id === tenant.staffId;
              const makeOwner = member.role !== "owner";
              const invite = inviteStatus(member, timezone);
              // Only someone who can still sign in and hasn't yet (S-42).
              const canInvite = member.active && invite.kind !== "joined";
              return (
                <li key={member.id} className="flex flex-col px-4 py-3 sm:px-5">
                  <div className="flex min-h-12 items-center gap-3">
                    <span
                      aria-hidden
                      className={cn(
                        "grid size-10 shrink-0 place-items-center rounded-full text-caption font-[650]",
                        member.active ? "bg-brand-soft text-ink" : "bg-surface-2 text-ink-2",
                      )}
                    >
                      {initialsOf(member.displayName)}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <p
                        className={cn(
                          "text-body font-semibold",
                          member.active ? "text-ink" : "text-ink-2",
                        )}
                      >
                        {member.displayName}
                        {you && <span className="font-normal text-ink-2"> (you)</span>}
                      </p>
                      <p className="text-caption [overflow-wrap:anywhere] text-ink-2">{member.email}</p>
                      {member.active && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                          <InviteStatusLabel status={invite} />
                          {invite.kind === "not_sent" && (
                            <Button
                              type="submit"
                              form={`invite-${member.id}`}
                              variant="secondary"
                              size="compact"
                            >
                              Send invite again
                            </Button>
                          )}
                        </div>
                      )}
                      <RoleLabel active={member.active} role={member.role} className="mt-1 self-start sm:hidden" />
                    </div>
                    <RoleLabel active={member.active} role={member.role} className="hidden sm:inline-block" />
                    {member.active && (
                      <RowMenu label={`More for ${member.displayName}`}>
                        {canInvite && (
                          <RowMenuItem
                            form={`invite-${member.id}`}
                            icon={<Mail aria-hidden strokeWidth={1.75} />}
                          >
                            {invite.kind === "not_invited" ? "Send invite" : "Send invite again"}
                          </RowMenuItem>
                        )}
                        <RowMenuItem
                          form={`role-${member.id}`}
                          icon={<UserCog aria-hidden strokeWidth={1.75} />}
                        >
                          {makeOwner ? "Make owner" : "Make staff"}
                        </RowMenuItem>
                        <RowMenuSeparator />
                        <RowMenuItem
                          form={`deactivate-${member.id}`}
                          tone="danger"
                          icon={<UserX aria-hidden strokeWidth={1.75} />}
                        >
                          Deactivate
                        </RowMenuItem>
                      </RowMenu>
                    )}
                  </div>
                  {member.active && (
                    // The menu items submit these; a refusal shows here, under the person.
                    <>
                      {canInvite && (
                        <ActionForm
                          id={`invite-${member.id}`}
                          action={`/api/staff/${member.id}/invite`}
                          className={refusalSpace}
                          savedMessage="Invite sent."
                        >
                          {null}
                        </ActionForm>
                      )}
                      <ActionForm
                        id={`role-${member.id}`}
                        action={`/api/staff/${member.id}/role`}
                        className={refusalSpace}
                      >
                        <input type="hidden" name="role" value={makeOwner ? "owner" : "staff"} />
                      </ActionForm>
                      <ActionForm
                        id={`deactivate-${member.id}`}
                        action={`/api/staff/${member.id}/deactivate`}
                        className={refusalSpace}
                        confirmation={{
                          title: `Deactivate ${member.displayName}?`,
                          description: "They won't be able to sign in.",
                          confirmLabel: "Deactivate",
                          cancelLabel: "Keep",
                        }}
                      >
                        {null}
                      </ActionForm>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>

        <Card as="section" aria-labelledby="add-someone" className="flex flex-col gap-4 p-4 sm:p-5">
          <h2 id="add-someone" className="text-title font-semibold text-ink">
            Add someone
          </h2>
          <ActionForm action="/api/staff" resetOnSuccess className="flex flex-col gap-4">
            <Field label="Name">
              <Input name="displayName" required maxLength={200} />
            </Field>
            <Field
              label="Email"
              hint="We email them an invite. They sign in with this address, with no password."
            >
              <Input name="email" type="email" required />
            </Field>
            <Field
              label="Role"
              hint={
                ownerLogins >= OWNER_LOGIN_SOFT_LIMIT &&
                "The standard plan includes one owner login. Adding another owner goes over that, but isn't blocked. Staff logins are unlimited."
              }
            >
              <Select name="role" defaultValue="staff">
                <option value="staff">Staff</option>
                <option value="owner">Owner</option>
              </Select>
            </Field>
            <Button type="submit" size="staff" className="self-start">
              Add
            </Button>
          </ActionForm>
        </Card>
      </div>
    </div>
  );
}

/** Owner, staff or deactivated, as a quiet label; deactivated reads without colour too. */
function RoleLabel({
  active,
  role,
  className,
}: {
  active: boolean;
  role: "owner" | "staff";
  className?: string;
}) {
  return (
    <span
      className={cn(
        className,
        "shrink-0 rounded-full px-2.5 py-0.5 text-caption font-semibold",
        !active
          ? "border border-line text-ink-2"
          : role === "owner"
            ? "bg-brand text-brand-ink"
            : "bg-surface-2 text-ink",
      )}
    >
      {active ? (role === "owner" ? "Owner" : "Staff") : "Deactivated"}
    </span>
  );
}
