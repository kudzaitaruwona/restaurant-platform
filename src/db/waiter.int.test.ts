import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { openOwnerDatabase } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { tableSessions } from "./schema";

/**
 * A waiter call lives only as long as its session (spec 06, "Call a waiter",
 * proposed): however a session closes, the flag goes with it, so no later reader
 * can show a closed session as calling. Written straight at Postgres.
 */
const owner = openOwnerDatabase();
afterAll(() => owner.pool.end());

const flagged = async () => {
  const { restaurantId, tableId } = await orderingRestaurant(owner.db);
  const [{ id }] = await owner.db
    .insert(tableSessions)
    .values({ restaurantId, tableId, waiterRequestedAt: new Date() })
    .returning({ id: tableSessions.id });
  return id;
};
const read = async (id: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, id)))[0];

describe("waiter_requested_at", () => {
  it("is cleared when the session closes, whatever the reason", async () => {
    for (const closeReason of ["staff_clear", "idle_expiry", "force_close"] as const) {
      const id = await flagged();
      await owner.db
        .update(tableSessions)
        .set({ status: "closed", closedAt: new Date(), closeReason })
        .where(eq(tableSessions.id, id));
      expect((await read(id)).waiterRequestedAt).toBeNull();
    }
  });

  it("can't be set on a session as it closes, nor on a closed one", async () => {
    const id = await flagged();
    await owner.db
      .update(tableSessions)
      .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear", waiterRequestedAt: new Date() })
      .where(eq(tableSessions.id, id));
    expect((await read(id)).waiterRequestedAt).toBeNull();

    await owner.db
      .update(tableSessions)
      .set({ waiterRequestedAt: new Date() })
      .where(eq(tableSessions.id, id));
    expect((await read(id)).waiterRequestedAt).toBeNull();
  });

  it("is left alone while the session stays open", async () => {
    const id = await flagged();
    const before = await read(id);
    await owner.db.update(tableSessions).set({ lastActivityAt: new Date() }).where(eq(tableSessions.id, id));
    expect((await read(id)).waiterRequestedAt).toEqual(before.waiterRequestedAt);
  });
});
