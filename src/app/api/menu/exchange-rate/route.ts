import type { NextRequest } from "next/server";
import { getCurrentRate, parseNewExchangeRate, rateChangeWarning, setExchangeRate } from "@/lib/exchange-rate";
import { confirmationNeeded } from "@/lib/confirm-response";
import { formSaved } from "@/lib/form-response";
import { liftedMessage } from "@/lib/special-price-refusal";
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
  const ask = await confirmationNeeded(request, form, "/dashboard/menu", async () => {
    const current = await getCurrentRate(tenant);
    const jump = rateChangeWarning(current?.usdToZig ?? null, rate.data.usdToZig);
    return jump ? [jump] : [];
  });
  if (ask) return ask;

  const result = await setExchangeRate(tenant, rate.data);
  if (result !== "saved") {
    return Response.json({ error: liftedMessage(result.above) }, { status: 400 });
  }
  return formSaved(request, "/dashboard/menu");
}
