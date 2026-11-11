import type { NextRequest } from "next/server";
import { newRestaurant, unknownTimezone } from "@/lib/new-restaurant";
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
    return Response.json(
      { error: input.error.issues[0].message },
      { status: 400 },
    );
  }

  const result = await createRestaurant(admin, input.data);
  if ("problem" in result) {
    return result.problem === "slug_taken"
      ? Response.json({ error: "That slug is already in use." }, { status: 409 })
      : Response.json({ error: unknownTimezone }, { status: 400 });
  }

  return Response.json({ id: result.id }, { status: 201 });
}
