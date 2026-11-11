import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { newOwner } from "@/lib/new-restaurant";
import {
  createFirstOwner,
  getPlatformAdminContext,
} from "@/lib/tenant/platform-admin";

const restaurantIdParam = z.uuid();

/** Creates a restaurant's first staff record, who is its owner (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/admin/restaurants/[restaurantId]/owner">,
) {
  const admin = await getPlatformAdminContext();

  const { restaurantId } = await context.params;
  const id = restaurantIdParam.safeParse(restaurantId);
  if (!id.success) notFound();

  const input = newOwner.safeParse(Object.fromEntries(await request.formData()));
  if (!input.success) {
    return Response.json(
      { error: input.error.issues[0].message },
      { status: 400 },
    );
  }

  const result = await createFirstOwner(admin, id.data, input.data);
  if ("problem" in result) {
    if (result.problem === "no_restaurant") notFound();
    return Response.json(
      {
        error:
          result.problem === "email_taken"
            ? "That email is already in use."
            : "This restaurant already has its first staff record.",
      },
      { status: 409 },
    );
  }

  return Response.json({ id: result.id }, { status: 201 });
}
