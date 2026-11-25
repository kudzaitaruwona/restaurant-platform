import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { confirmationNeeded, zeroPriceWarnings } from "@/lib/confirmation";
import { formSaved } from "@/lib/form-response";
import {
  alreadyOverMessage,
  createSpecial,
  overlapMessage,
  parseNewSpecial,
} from "@/lib/specials";
import { newSpecialMessage } from "@/lib/special-price-refusal";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Adds a promotion, from /dashboard/menu. Owner only (S-26). The item is in the
 * form rather than the URL, because the form chooses it; the restaurant is the
 * session's and nothing in the request can change that.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const form = await request.formData().catch(() => new FormData());
  const special = parseNewSpecial(form);
  if (!special.success) {
    return Response.json({ error: special.message }, { status: 400 });
  }
  const ask = confirmationNeeded(
    zeroPriceWarnings({ usd: special.data.priceUsd, zig: special.data.priceZig }, "special"),
    form,
  );
  if (ask) return ask;

  const result = await createSpecial(tenant, special.data);
  if (result === "no_such_item") notFound();
  if (result === "overlap") {
    return Response.json({ error: overlapMessage }, { status: 409 });
  }
  if (result === "already_over") {
    return Response.json({ error: alreadyOverMessage }, { status: 400 });
  }
  if (result !== "saved") {
    return Response.json({ error: newSpecialMessage(result.above) }, { status: 400 });
  }
  return formSaved(request, "/dashboard/menu");
}
