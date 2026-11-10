import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diningTables, orderItems, restaurants, tableSessions } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../../test/integration/database";
import { orderingRestaurant } from "../../../../../../test/integration/ordering";
import { POST as joinSession } from "../session/route";
import { POST as placeOrder } from "../orders/route";
import { GET } from "./route";

/**
 * The order tracker's feed (spec 06, step 3): every item in the table's open
 * session, for every phone at the table, and nothing else. Against a real
 * Postgres as app_tenant.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const params = (qrToken: string) => ({ params: Promise.resolve({ qrToken }) });
const join = async (qrToken: string) =>
  (await (await joinSession(new Request("http://localhost/x", { method: "POST" }), params(qrToken))).json())
    .session as string;
const order = (qrToken: string, fields: Record<string, string>) =>
  placeOrder(
    new Request(`http://localhost/api/t/${qrToken}/orders`, {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params(qrToken),
  );
const track = (qrToken: string) =>
  GET(new Request(`http://localhost/api/t/${qrToken}/tracker`), params(qrToken));

describe("GET /api/t/[qrToken]/tracker", () => {
  it("lists every item of the open session, from every phone, oldest first", async () => {
    const r = await orderingRestaurant(owner.db);
    const session = await join(r.qrToken);
    await order(r.qrToken, { item: r.itemId, quantity: "2", note: "no onions", name: "Tariro", session });
    await order(r.qrToken, { item: r.itemId, quantity: "1", name: "Farai", session });

    const response = await track(r.qrToken);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.session).toBe(session);
    expect(body.items).toEqual([
      { quantity: 2, name: "Beef stew", note: "no onions", customer: "Tariro", status: "placed", time: expect.stringMatching(/^\d\d:\d\d$/) },
      { quantity: 1, name: "Beef stew", note: null, customer: "Farai", status: "placed", time: expect.stringMatching(/^\d\d:\d\d$/) },
    ]);
  });

  it("carries each item's current status, and shows a voided one as voided", async () => {
    const r = await orderingRestaurant(owner.db);
    const session = await join(r.qrToken);
    await order(r.qrToken, { item: r.itemId, quantity: "1", name: "Tariro", session });
    await owner.db.update(orderItems).set({ status: "cooking" }).where(eq(orderItems.restaurantId, r.restaurantId));
    expect((await (await track(r.qrToken)).json()).items[0].status).toBe("cooking");

    await owner.db
      .update(orderItems)
      .set({ status: "voided", voidReason: "Wrong table", voidedBy: r.staffId })
      .where(eq(orderItems.restaurantId, r.restaurantId));

    const item = (await (await track(r.qrToken)).json()).items[0];
    expect(item.status).toBe("voided");
    // What staff wrote is theirs: the customer's page never gets the reason.
    expect(JSON.stringify(item)).not.toContain("Wrong table");
  });

  it("shows the time an item was ordered on the restaurant's clock, not the server's", async () => {
    const r = await orderingRestaurant(owner.db);
    await owner.db.update(restaurants).set({ timezone: "Pacific/Auckland" }).where(eq(restaurants.id, r.restaurantId));
    const session = await join(r.qrToken);
    await order(r.qrToken, { item: r.itemId, quantity: "1", name: "Tariro", session });

    const [{ time }] = (await (await track(r.qrToken)).json()).items;

    const expected = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Pacific/Auckland",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date());
    // The same minute, or the one before it if the clock ticked over.
    const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
    expect(Math.abs(minutes(time) - minutes(expected))).toBeLessThanOrEqual(1);
  });

  it("is empty, with no session, for a table nobody has scanned", async () => {
    const r = await orderingRestaurant(owner.db);
    expect(await (await track(r.qrToken)).json()).toEqual({ session: null, items: [] });
  });

  it("says nothing of a closed session: the table's next session starts empty", async () => {
    const r = await orderingRestaurant(owner.db);
    const old = await join(r.qrToken);
    await order(r.qrToken, { item: r.itemId, quantity: "1", name: "Old party", session: old });
    await owner.db
      .update(tableSessions)
      .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear" })
      .where(eq(tableSessions.id, old));

    expect(await (await track(r.qrToken)).json()).toEqual({ session: null, items: [] });
    const fresh = await join(r.qrToken);
    const body = await (await track(r.qrToken)).json();
    expect(body).toEqual({ session: fresh, items: [] });
  });

  it("shows only its own table: another table's items never appear", async () => {
    const mine = await orderingRestaurant(owner.db);
    const theirs = await orderingRestaurant(owner.db);
    const theirSession = await join(theirs.qrToken);
    await order(theirs.qrToken, { item: theirs.itemId, quantity: "1", name: "Someone else", session: theirSession });
    await join(mine.qrToken);

    const text = JSON.stringify(await (await track(mine.qrToken)).json());

    expect(text).not.toContain("Someone else");
    expect(text).not.toContain(theirSession);
  });

  it("shows another table of the same restaurant nothing either", async () => {
    const r = await orderingRestaurant(owner.db);
    const [{ qrToken: second }] = await owner.db
      .insert(diningTables)
      .values({ restaurantId: r.restaurantId, label: "Table 8", capacity: 2, qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22) })
      .returning({ qrToken: diningTables.qrToken });
    const session = await join(r.qrToken);
    await order(r.qrToken, { item: r.itemId, quantity: "1", name: "Table seven", session });
    await join(second);

    expect((await (await track(second)).json()).items).toEqual([]);
  });

  it("is a 404 for an unknown token, and for a table that was archived", async () => {
    const r = await orderingRestaurant(owner.db);
    expect((await track("no-such-token")).status).toBe(404);
    expect((await track("a\0b")).status).toBe(404);
    await owner.db.update(diningTables).set({ archivedAt: new Date() }).where(eq(diningTables.id, r.tableId));
    expect((await track(r.qrToken)).status).toBe(404);
  });

  it("is a read: polling doesn't count as activity or open a session", async () => {
    const r = await orderingRestaurant(owner.db);
    await track(r.qrToken);
    expect(await owner.db.select().from(tableSessions).where(eq(tableSessions.tableId, r.tableId))).toEqual([]);
  });
});
