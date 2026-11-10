import { getSystemDb } from "@/db/system";
import { isAuthorizedCronCall } from "@/lib/cron/authorize";
import { runTick } from "@/lib/cron/tick";
import { getEnv } from "@/lib/env";

/**
 * The 5-minute scheduled job (S-35). Vercel Cron calls it on the schedule in
 * vercel.ts, with `Authorization: Bearer <CRON_SECRET>`; in development and
 * tests it is called directly with the secret, and nothing schedules it.
 *
 * It takes no input: nothing in the query or body chooses what runs or for which
 * restaurant. It is the only route that opens the system login
 * (DATABASE_URL_SYSTEM, BYPASSRLS), besides the Meta webhook, and only after
 * the secret checks out. Reading the header first also keeps the
 * route dynamic: nothing here may be prerendered.
 */
export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!isAuthorizedCronCall(authorization, getEnv().CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const result = await runTick(getSystemDb(), new Date());
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
