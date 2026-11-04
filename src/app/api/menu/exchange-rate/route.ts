import type { NextRequest } from "next/server";
import { parseNewExchangeRate, setExchangeRate } from "@/lib/exchange-rate";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Sets "1 USD = ___ ZiG", from /dashboard/menu. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const rate = parseNewExchangeRate(
    await request.formData().catch(() => new FormData()),
  );
  if (!rate.success) {
    return Response.json({ error: rate.message }, { status: 400 });
  }

  await setExchangeRate(tenant, rate.data);
  return formSaved(request, "/dashboard/menu");
}
