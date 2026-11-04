import "server-only";
import { eq } from "drizzle-orm";
import { getAdminDb } from "@/db/admin";
import { adminAuthEntry } from "@/db/schema";

/**
 * The restaurant this admin session has entered, if any, and the shadow staff
 * row it acts through. Looked up by session, so nothing the browser sends can
 * name a tenant. The foreign keys keep this true: an entry can't outlive its
 * session or its shadow row.
 */
export async function enteredRestaurant(sessionId: string) {
  const [entry] = await getAdminDb()
    .select({
      restaurantId: adminAuthEntry.enteredRestaurantId,
      staffId: adminAuthEntry.shadowStaffId,
    })
    .from(adminAuthEntry)
    .where(eq(adminAuthEntry.sessionId, sessionId));
  return entry;
}
