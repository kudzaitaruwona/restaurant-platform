/**
 * Runs once when a Next.js server instance starts, before it serves requests.
 * Validating the environment here makes a misconfigured deploy fail fast
 * with a list of the bad variables instead of failing on some later request.
 *
 * `next build` is skipped: it runs without runtime secrets (in CI and on
 * Vercel), and nothing at build time reads them.
 */
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { getEnv } = await import("./lib/env");
  getEnv();
}
