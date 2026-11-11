import { getBoard } from "@/lib/kitchen";
import { getTenantContext } from "@/lib/tenant";
import { KitchenBoard } from "./kitchen-board";

/**
 * The kitchen board (spec 07, at /dashboard/kitchen per D-10), for anyone on
 * the team (S-26). The server renders the whole board; the board then keeps
 * itself live by polling. React escapes what a customer typed.
 */
export async function KitchenScreen() {
  const tenant = await getTenantContext();
  const board = await getBoard(tenant);

  return <KitchenBoard initial={board} />;
}
