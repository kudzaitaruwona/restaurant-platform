import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { addStaff, parseNewStaff } from "@/lib/staff-management";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds a staff member or an owner, from /dashboard/staff. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const person = parseNewStaff(
    await request.formData().catch(() => new FormData()),
  );
  if (!person.success) {
    return Response.json({ error: person.message }, { status: 400 });
  }

  const result = await addStaff(tenant, person.data);
  if (result === "needs_owner_first") {
    return Response.json(
      { error: "This restaurant has no owner yet, so add its owner first." },
      { status: 409 },
    );
  }
  if (result === "email_taken") {
    // Emails are unique across restaurants, so this can't say more than this.
    return Response.json(
      { error: "That email can't be added: it already has a staff login." },
      { status: 409 },
    );
  }

  return formSaved(request, "/dashboard/staff");
}
