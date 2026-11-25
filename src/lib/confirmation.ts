/**
 * Saves that ask first (issue #112): a zero price, a big rate jump, a name that
 * is already on the menu. The route answers 409 with `confirm.warnings` and
 * saves nothing; the form (ActionForm) shows them in a dialog and, if the owner
 * goes ahead, posts again with `confirmed=1`. The server decides what is worth
 * asking about, so a caller that skips the dialog gets the same 409.
 */

export const CONFIRMED_FIELD = "confirmed";

export const isConfirmed = (form: FormData) => form.get(CONFIRMED_FIELD) === "1";

/** Null when nothing needs asking, or the answer to send. */
export function confirmationNeeded(warnings: string[], form: FormData) {
  if (warnings.length === 0 || isConfirmed(form)) return null;
  return Response.json({ error: warnings.join(" "), confirm: { warnings } }, { status: 409 });
}

/** Zero is a price the form takes (a free item), but it is usually a slip. */
export const isZero = (price: string | null) => price !== null && Number(price) === 0;

export function zeroPriceWarnings(prices: { usd: string | null; zig: string | null }, noun = "item") {
  const zeros = [isZero(prices.usd) && "USD", isZero(prices.zig) && "ZiG"].filter(Boolean);
  return zeros.length === 0
    ? []
    : [`The ${zeros.join(" and ")} price is 0, so this ${noun} would be free.`];
}
