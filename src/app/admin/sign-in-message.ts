/**
 * The message the admin can send a new owner on WhatsApp, beside the invite
 * email (S-42), which may sit unread or go to spam. Plain text for the
 * clipboard: React escapes it on screen.
 */
export function ownerSignInMessage({
  restaurantName,
  appUrl,
  ownerName,
  ownerEmail,
}: {
  restaurantName: string;
  appUrl: string;
  /** Their full name; the greeting uses the first word. */
  ownerName?: string;
  /** Known only right after the admin types it; otherwise the message says "your email". */
  ownerEmail?: string;
}) {
  const firstName = ownerName?.trim().split(/\s+/)[0];
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";
  const loginUrl = new URL("/login", appUrl).toString();
  const email = ownerEmail?.trim() || "the email address you gave us";
  return (
    `${greeting} ${restaurantName.trim()} is ready for you. ` +
    `Sign in at ${loginUrl} with ${email}. ` +
    "You will get a sign-in link or a code by email. There is no password."
  );
}
