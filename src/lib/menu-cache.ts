import { revalidateTag } from "next/cache";

/**
 * The public menu page's cache tag. One per restaurant, on everything the page
 * is built from, so a save refreshes that restaurant and no other.
 */
export const menuTag = (restaurantId: string) => `menu:${restaurantId}`;

/**
 * Call after any change the public page shows, once it has committed. `expire: 0`
 * rather than the recommended "max": with "max" the next customer would get the
 * old page while the new one renders, and a price is the one thing here that
 * mustn't be out of date after someone has saved it.
 */
export function revalidateMenu({ restaurantId }: { restaurantId: string }) {
  revalidateTag(menuTag(restaurantId), { expire: 0 });
}
