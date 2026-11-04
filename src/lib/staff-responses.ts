import { notFound } from "next/navigation";
import { z } from "zod";
import { formSaved } from "./form-response";
import type { StaffChange } from "./staff-management";

/** The id in a staff route. A malformed one is a 404, like an unknown one. */
export async function staffIdFrom(params: Promise<{ staffId: string }>) {
  const parsed = z.uuid().safeParse((await params).staffId);
  if (!parsed.success) notFound();
  return parsed.data;
}

/** Answers a staff form post with what happened to the change. */
export function staffChangeResponse(outcome: StaffChange, request: Request) {
  if (outcome === "not_found") notFound();
  if (outcome === "last_owner") {
    return Response.json(
      { error: "A restaurant needs at least one active owner. Make someone else an owner first." },
      { status: 409 },
    );
  }
  return formSaved(request, "/dashboard/staff");
}
