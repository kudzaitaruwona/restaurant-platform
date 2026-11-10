import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { moveItem } from "@/lib/kitchen";
import { getTenantContext } from "@/lib/tenant";

const headers = { "cache-control": "no-store" };
const status = z.enum(["placed", "cooking", "done", "delivered", "voided"]);

/**
 * One tap on the kitchen board (spec 07): moves a line one status forward, or
 * back one for a mis-tap. The form says the status the board showed (`from`) and
 * the one wanted (`to`). Owner and staff (S-26); the restaurant comes from the
 * session, and a line of another restaurant is a 404. A skipped status, or a line
 * that is no longer in `from` because another tablet moved it first, is a 409
 * carrying the status it is in, and the board refreshes.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/kitchen/items/[itemId]/status">,
) {
  const tenant = await getTenantContext();
  const itemId = z.uuid().safeParse((await context.params).itemId);
  if (!itemId.success) notFound();
  const form = await request.formData().catch(() => new FormData());
  const from = status.safeParse(form.get("from"));
  const to = status.safeParse(form.get("to"));
  if (!from.success || !to.success) {
    return Response.json({ error: "That request wasn't valid." }, { status: 400, headers });
  }

  const outcome = await moveItem(tenant, itemId.data, from.data, to.data);
  switch (outcome.outcome) {
    case "not_found":
      notFound();
    case "wrong_status":
      return Response.json(
        { error: "That item had already moved. The board is up to date now.", status: outcome.status },
        { status: 409, headers },
      );
    case "done":
      return Response.json({ item: outcome.item }, { headers });
  }
}
