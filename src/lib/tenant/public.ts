import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db";
import type { TenantContext } from "./scope";

/**
 * The public seam (spec 01 › Tenant isolation), where a route with no session
 * finds its tenant. The token is the only tenant input such a route accepts; the
 * restaurant it names then scopes every further query through withTenant().
 *
 * RLS hides `restaurants` from app_tenant until a tenant is set, so each kind of
 * token has a SECURITY DEFINER function that returns an id and nothing else
 * (S-31). A new kind of token adds one here. Only this file calls them.
 */
const lookups = {
  menu: (token: string) => sql`select restaurant_id_by_menu_token(${token}) as id`,
} satisfies Record<string, (token: string) => SQL>;

export type PublicTokenKind = keyof typeof lookups;

export type PublicTenant = Pick<TenantContext, "restaurantId">;

export async function resolvePublicToken(
  kind: PublicTokenKind,
  token: string,
): Promise<PublicTenant | undefined> {
  const { rows } = await getDb().execute<{ id: string | null }>(
    lookups[kind](token),
  );
  const [{ id }] = rows;
  return id ? { restaurantId: id } : undefined;
}
