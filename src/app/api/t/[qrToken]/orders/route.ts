import { declaredLength, MAX_BODY_BYTES, readFormWithin } from "@/lib/booking-limits";
import { parseOrderRequest, placeOrder } from "@/lib/ordering";

const headers = { "cache-control": "no-store" };

const refuse = (error: string, status: number, extra?: Record<string, string>) =>
  Response.json({ error, ...extra }, { status, headers });

/**
 * A customer's order from a table's page (spec 06, S-36): no session, no
 * approval, no code. The token in the path is the only tenant input, and the
 * body carries only the item, quantity, note and name, plus the session the page
 * joined, which is checked, never written to by id. Prices are worked out on the
 * server. Uncached and outside /t/, because the proxy keeps every write off the
 * cached menu (S-32). What it costs to ask is bounded before anything else.
 */
export async function POST(request: Request, { params }: RouteContext<"/api/t/[qrToken]/orders">) {
  const length = declaredLength(request.headers);
  if (length === "invalid") return refuse("That request wasn't valid.", 400);
  if (length !== undefined && length > MAX_BODY_BYTES) return refuse("That request was too large.", 413);
  const form = await readFormWithin(request);
  if (form === "too_large") return refuse("That request was too large.", 413);

  const parsed = parseOrderRequest(form);
  if (!parsed.success) return refuse(parsed.message, 400);

  const result = await placeOrder((await params).qrToken, parsed.data);
  switch (result.outcome) {
    case "placed":
      return Response.json({ placed: result.placed }, { status: 201, headers });
    case "no_table":
      return refuse("This code is out of date. Ask a member of staff for help.", 404);
    case "session_changed":
      return refuse(
        "Your table's order was reset by staff. Check your order, then place it again.",
        409,
        { code: "session_changed" },
      );
    case "unavailable":
      return refuse("Sorry, that item isn't available right now.", 409, { code: "unavailable" });
    case "rate_limited":
      return Response.json(
        { error: "That's a lot of orders at once. Wait a few minutes, or ask a member of staff." },
        { status: 429, headers: { ...headers, "Retry-After": String(result.retryAfterSeconds) } },
      );
  }
}
