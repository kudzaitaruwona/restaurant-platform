import type { Confirmation, TimeChoice } from "@/lib/bookings";
import { postForm } from "@/lib/form-response";
import { bookedPath } from "./just-booked";

/**
 * What makes a retry the same submission (#134): an id of the page's own, sent with
 * every try until one is answered as booked. It is kept for the tab, so a reload or
 * another time after a lost answer is still the same submission. On its own it opens
 * nothing: the server gives a booking back only for its id with its every detail.
 */
const key = (action: string) => `booking-request:${action}`;

/** The same, for a page whose storage is blocked: it lasts as long as the page does. */
const kept = new Map<string, string>();

/** A version 4 UUID. Not crypto.randomUUID, which older phones and plain http lack. */
function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

export function submissionId(action: string) {
  let id: string | null | undefined;
  try {
    id = sessionStorage.getItem(key(action));
  } catch {}
  id ??= kept.get(action) ?? newId();
  kept.set(action, id);
  try {
    sessionStorage.setItem(key(action), id);
  } catch {}
  return id;
}

/** It has booked: the next one is a submission of its own. */
export function submissionBooked(action: string) {
  kept.delete(action);
  try {
    sessionStorage.removeItem(key(action));
  } catch {}
}

export type Contact = { contactPhone: string | null; whatsappLink: string | null };
export type Refusal = {
  error: string;
  times?: TimeChoice[];
  available?: TimeChoice[];
  /** This submission has booked already, with other details. */
  alreadyBooked?: boolean;
  /** Where that booking is, when this page can say. Never in its markup or URL. */
  booked?: string;
} & Partial<Contact>;

/** Nobody can say whether it was booked; the id makes asking again safe. */
export const lostMessage =
  "We didn't hear back from the restaurant, so we can't tell if that was booked. Confirm again: you won't be booked twice.";

/**
 * Sends a submission. Throws when its answer is lost (no response, a 5xx, a body cut
 * short): it may have booked.
 */
export async function submit(
  action: string,
  body: FormData,
): Promise<{ booked: string } | { status: number; refusal: Refusal }> {
  const response = await postForm(action, body);
  if (response.status >= 500) throw new Error(`answered ${response.status}`);
  const answer = await response.json();
  return response.ok
    ? { booked: bookedPath((answer.confirmation as Confirmation).manageToken) }
    : { status: response.status, refusal: answer };
}

/**
 * The booking one of these tries made, once the server has said their id has booked.
 * So none of them can book now: each is answered with its own booking or refused.
 */
export async function bookingOfLost(action: string, tries: readonly FormData[]) {
  for (const body of tries) {
    const answer = await submit(action, body).catch(() => undefined);
    if (answer && "booked" in answer) return answer.booked;
  }
  return undefined;
}
