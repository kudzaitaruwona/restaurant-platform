/**
 * A stored E.164 number as a guest reads it: "+263771234567" is shown as
 * "+263 77 123 4567". Only Zimbabwe's shape is known here; any other number is
 * shown as stored. Display only: a `tel:` link keeps the E.164 value.
 */
export function displayPhone(e164: string) {
  const zimbabwe = /^\+263(\d{2})(\d{3})(\d{4})$/.exec(e164);
  return zimbabwe ? `+263 ${zimbabwe[1]} ${zimbabwe[2]} ${zimbabwe[3]}` : e164;
}
