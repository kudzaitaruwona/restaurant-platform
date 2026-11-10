/**
 * Vercel project configuration (S-35). Vercel reads this file in place of a
 * vercel.json. The only thing configured here is the scheduled job: one cron,
 * every 5 minutes, calling GET /api/cron/tick with `Authorization: Bearer
 * <CRON_SECRET>` once CRON_SECRET is set in the project's environment. Vercel
 * Cron runs on the production deployment only, so nothing schedules it locally.
 *
 * Typed here rather than with @vercel/config's VercelConfig, so the schedule
 * adds no dependency; only the keys used are described.
 */
type Cron = { path: `/${string}`; schedule: string };

export const config: { crons: Cron[] } = {
  crons: [{ path: "/api/cron/tick", schedule: "*/5 * * * *" }],
};
