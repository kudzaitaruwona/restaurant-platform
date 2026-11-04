import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { devAuthBypassEnabled } from "@/lib/env";
import {
  DEV_IDENTITY_COOKIE,
  findDevIdentity,
} from "@/lib/tenant/dev-identities";

/**
 * The dev switcher (S-25): picks which seeded identity getTenantContext()
 * returns. A 404 unless the bypass is on, so it doesn't exist in production.
 */
export async function POST(request: Request) {
  if (!devAuthBypassEnabled()) notFound();

  const key = (await request.formData()).get("identity");
  const identity = typeof key === "string" ? findDevIdentity(key) : undefined;
  if (!identity) {
    return Response.json({ error: "Unknown identity." }, { status: 400 });
  }

  (await cookies()).set(DEV_IDENTITY_COOKIE, identity.key, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  return new Response(null, { status: 303, headers: { Location: "/dashboard" } });
}
