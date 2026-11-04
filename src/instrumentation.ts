/**
 * Runs once when a Next.js server instance starts, before it serves requests.
 * Validating the environment here makes a misconfigured server exit with a
 * list of the bad variables instead of failing on some later request.
 *
 * `next build` is skipped: it runs without runtime secrets (in CI and on
 * Vercel), and nothing at build time reads them.
 */
export async function register() {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { EnvValidationError, getEnv } = await import("./lib/env");
  try {
    getEnv();
  } catch (error) {
    // Exit here, because rethrowing doesn't stop the server: `next start` logs
    // a rejected register(), keeps the port open and answers every route with
    // a 500. The message holds variable names and rules, never values.
    if (
      process.env.NEXT_RUNTIME === "nodejs" &&
      error instanceof EnvValidationError
    ) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
