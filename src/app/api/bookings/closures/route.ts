import type { NextRequest } from "next/server";
import { addClosure, parseClosure } from "@/lib/booking-closures";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Adds a closure, from /dashboard/bookings/settings. Owner only (S-26). A closure
 * over confirmed bookings answers 409 with those bookings listed (name, time,
 * party: never a phone) so staff can cancel them first.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const closure = parseClosure(await request.formData().catch(() => new FormData()));
  if (!closure.success) {
    return Response.json({ error: closure.message }, { status: 400 });
  }

  const outcome = await addClosure(tenant, closure.data);
  if (outcome.outcome === "invalid") {
    return Response.json({ error: outcome.message }, { status: 400 });
  }
  if (outcome.outcome === "blocked") {
    return Response.json({ error: outcome.message, bookings: outcome.bookings }, { status: 409 });
  }
  return formSaved(request, "/dashboard/bookings/settings");
}
