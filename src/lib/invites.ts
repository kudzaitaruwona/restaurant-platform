import "server-only";
import { type Email, emailSender } from "@/lib/auth/email";
import { getEnv } from "@/lib/env";

/**
 * Invites (S-42): an email telling someone they have an account and how to sign
 * in. The functions that make a staff member or a restaurant's owner send one
 * themselves (staff-management.ts, tenant/platform-admin.ts), so every caller
 * invites. Each send is recorded in staff_invites first, where Postgres holds
 * the limit below, and its outcome after.
 */

/** Per person per hour, the first invite included. The trigger in 0050 holds it. */
export const INVITES_PER_HOUR = 3;

/** SQLSTATEs the invite functions and trigger raise. */
export const TOO_MANY_INVITES = "PA002";
export const ALREADY_JOINED = "PA003";

export type ResendOutcome = "sent" | "not_sent" | "not_found" | "joined" | "too_many";

export const appUrl = () => getEnv().NEXT_PUBLIC_APP_URL;

/**
 * Sends it and says whether the provider took it. A failure never undoes the
 * account: the caller records it, and the screen offers "Send invite again".
 * Logged without the address, as the sign-in sender's errors are.
 */
export async function deliverInvite(email: Email): Promise<boolean> {
  try {
    await emailSender().send(email);
    return true;
  } catch (error) {
    console.error(`An invite email didn't go: ${(error as Error).message}`);
    return false;
  }
}

export const sqlStateOf = (error: unknown) =>
  (error as { cause?: { code?: unknown } } | null)?.cause?.code;
