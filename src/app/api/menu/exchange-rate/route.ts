import type { NextRequest } from "next/server";
import { getCurrentRate, parseNewExchangeRate, rateChangeWarning, setExchangeRate } from "@/lib/exchange-rate";
import { confirmationNeeded } from "@/lib/confirmation";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Sets "1 USD = ___ ZiG", from /dashboard/menu. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const form = await request.formData().catch(() => new FormData());
  const rate = parseNewExchangeRate(form);
  if (!rate.success) {
    return Response.json({ error: rate.message }, { status: 400 });
  }
  const current = await getCurrentRate(tenant);
  const jump = rateChangeWarning(current?.usdToZig ?? null, rate.data.usdToZig);
  const ask = confirmationNeeded(jump ? [jump] : [], form);
  if (ask) return ask;

  await setExchangeRate(tenant, rate.data);
  return formSaved(request, "/dashboard/menu");
}
