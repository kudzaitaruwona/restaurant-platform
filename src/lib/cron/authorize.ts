import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** Shorter than this isn't a secret anyone generated for the purpose (S-35). */
export const MIN_CRON_SECRET_LENGTH = 32;

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Whether a call to the scheduled job's route carries `Authorization: Bearer
 * <CRON_SECRET>`, which Vercel Cron sends (S-35). Fails closed: with no secret
 * set, or one under 32 characters, nothing is let in. Compared as SHA-256
 * digests with timingSafeEqual, so the time taken says nothing about how much of
 * the header matched, its length included.
 */
export function isAuthorizedCronCall(authorization: string | null, secret: string | undefined) {
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH || authorization === null) return false;
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
