import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { handleAuthRequest } from "@/lib/auth";

/** Better Auth, for both session types: /api/auth/staff/* and /api/auth/admin/*. */
async function handle(
  request: NextRequest,
  context: RouteContext<"/api/auth/[audience]/[...all]">,
) {
  const { audience } = await context.params;
  if (audience !== "staff" && audience !== "admin") notFound();
  return handleAuthRequest(audience, request);
}

export { handle as GET, handle as POST };
