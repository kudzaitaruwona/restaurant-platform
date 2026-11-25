import type { NextRequest } from "next/server";
import { addressTaken, newRestaurant, unknownTimezone } from "@/lib/new-restaurant";
import {
  createRestaurant,
  getPlatformAdminContext,
} from "@/lib/tenant/platform-admin";

/** Creates a restaurant. It has no staff yet: its first owner comes next. */
export async function POST(request: NextRequest) {
  const admin = await getPlatformAdminContext();

  const input = newRestaurant.safeParse(
    Object.fromEntries(await request.formData()),
  );
  if (!input.success) {
    const [issue] = input.error.issues;
    // `field` lets the form put the message under the field that caused it.
    return Response.json({ error: issue.message, field: issue.path[0] }, { status: 400 });
  }

  const result = await createRestaurant(admin, input.data);
  if ("problem" in result) {
    return result.problem === "slug_taken"
      ? Response.json({ error: addressTaken(), field: "slug" }, { status: 409 })
      : Response.json({ error: unknownTimezone, field: "timezone" }, { status: 400 });
  }

  return Response.json({ id: result.id }, { status: 201 });
}
