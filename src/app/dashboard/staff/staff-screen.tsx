import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  countOwnerLogins,
  listStaff,
  OWNER_LOGIN_SOFT_LIMIT,
} from "@/lib/staff-management";
import { getTenantContext, requireOwner } from "@/lib/tenant";
import { ActionForm } from "../action-form";
import { Field, inputClassName } from "../field";

/** Staff management: owner only (S-26). */
export async function StaffScreen() {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const team = await listStaff(tenant);
  const ownerLogins = countOwnerLogins(team);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground underline">
          Back to dashboard
        </Link>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Staff</h1>
      </div>

      {ownerLogins > OWNER_LOGIN_SOFT_LIMIT && (
        <p role="status" className="rounded-md border p-3 text-sm">
          This restaurant has {ownerLogins} owner logins, more than the one
          included in the standard plan. Nothing is blocked.
        </p>
      )}

      <ul className="flex flex-col divide-y">
        {team.map((member) => (
          <li key={member.id} className="flex flex-col gap-2 py-3">
            <div>
              <p className="font-medium">
                {member.displayName}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  {member.active ? member.role : "Deactivated"}
                  {member.id === tenant.staffId && " (you)"}
                </span>
              </p>
              <p className="text-sm break-all text-muted-foreground">{member.email}</p>
            </div>
            {member.active && (
              <div className="flex flex-wrap gap-2">
                <ActionForm action={`/api/staff/${member.id}/role`}>
                  <input
                    type="hidden"
                    name="role"
                    value={member.role === "owner" ? "staff" : "owner"}
                  />
                  <Button type="submit" variant="outline" size="sm">
                    {member.role === "owner" ? "Make staff" : "Make owner"}
                  </Button>
                </ActionForm>
                <ActionForm
                  action={`/api/staff/${member.id}/deactivate`}
                  confirmation={`Deactivate ${member.displayName}? They won't be able to sign in.`}
                >
                  <Button type="submit" variant="destructive" size="sm">
                    Deactivate
                  </Button>
                </ActionForm>
              </div>
            )}
          </li>
        ))}
      </ul>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-xl font-semibold">Add someone</h2>
        <ActionForm action="/api/staff" resetOnSuccess className="flex flex-col gap-3">
          <Field label="Name">
            <input name="displayName" required maxLength={200} className={inputClassName} />
          </Field>
          <Field label="Email" hint="They sign in with this address.">
            <input name="email" type="email" required className={inputClassName} />
          </Field>
          <Field
            label="Role"
            hint={
              ownerLogins >= OWNER_LOGIN_SOFT_LIMIT &&
              "The standard plan includes one owner login. Adding another owner goes over that, but isn't blocked. Staff logins are unlimited."
            }
          >
            <select name="role" defaultValue="staff" className={inputClassName}>
              <option value="staff">Staff</option>
              <option value="owner">Owner</option>
            </select>
          </Field>
          <Button type="submit" className="self-start">
            Add
          </Button>
        </ActionForm>
      </section>
    </div>
  );
}
