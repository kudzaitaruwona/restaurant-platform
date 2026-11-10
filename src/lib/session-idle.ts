/**
 * Spec 06's idle expiry: a session with no activity for this long closes, by the
 * scheduled job (src/lib/cron/idle-expiry.ts), unless a line is still in play,
 * in which case the floor view flags it instead (src/lib/floor.ts). One number
 * for both, so the job and the floor can't disagree about what "idle" is.
 */
export const IDLE_EXPIRY_MINUTES = 90;
