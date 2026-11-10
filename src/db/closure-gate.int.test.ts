import type { PoolClient } from "@neondatabase/serverless";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openOwnerDatabase, openSystemDatabase, openTestDatabase } from "../../test/integration/database";
import { orderingRestaurant } from "../../test/integration/ordering";
import { orderItems, orders, tableSessions } from "./schema";

/**
 * The closure gate (spec 00, Enforced in the database; spec 06, Sessions; #74):
 * a session can't close while any of its lines is placed, cooking or done, by
 * any path, whoever runs it. Written straight at Postgres, as app_tenant where
 * the app would be and as the owner role, with none of the app's checks in the
 * way. Force-close passes it by voiding first (src/lib/closing.int.test.ts).
 */
const app = openTestDatabase();
const owner = openOwnerDatabase();
const system = openSystemDatabase();
afterAll(() => Promise.all([app.pool.end(), owner.pool.end(), system.pool.end()]));

type Restaurant = Awaited<ReturnType<typeof orderingRestaurant>>;
type Status = (typeof orderItems.$inferSelect)["status"];

const GATE = "23514/table_sessions_closure_gate";
const SESSION_CLOSED = "23514/order_items_session_open";

/** An open session on the restaurant's table, with an order of lines in the given statuses. */
async function sessionWith(r: Restaurant, statuses: Status[]) {
  const [{ id: sessionId }] = await owner.db
    .insert(tableSessions)
    .values({ restaurantId: r.restaurantId, tableId: r.tableId })
    .returning({ id: tableSessions.id });
  const [{ id: orderId }] = await owner.db
    .insert(orders)
    .values({ restaurantId: r.restaurantId, sessionId, customerName: "Tariro" })
    .returning({ id: orders.id });
  for (const status of statuses) {
    await owner.db.insert(orderItems).values({
      restaurantId: r.restaurantId,
      orderId,
      menuItemId: r.itemId,
      nameSnapshot: "Beef stew",
      quantity: 1,
      unitPriceUsd: "8",
      status,
      ...(status === "voided" ? { voidReason: "Sent back", voidedBy: r.staffId } : {}),
    });
  }
  return { sessionId, orderId };
}

const CLOSE = `update table_sessions set status = 'closed', closed_at = now(), close_reason = 'staff_clear'
  where id = $1`;

const outcome = (statement: Promise<unknown>) =>
  statement.then(
    () => "passed",
    (error: { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } }) => {
      const e = error.cause ?? error;
      return e.constraint ? `${e.code}/${e.constraint}` : String(e.code);
    },
  );

type Party = PoolClient & { pid: number };

/** A transaction as the app runs it: app_tenant, inside the tenant, nothing locked yet. */
async function aTenant(restaurantId: string, isolation = "read committed") {
  const client = await app.pool.connect();
  await client.query(`begin isolation level ${isolation}`);
  await client.query("select set_config('app.restaurant_id', $1, true)", [restaurantId]);
  const { rows } = await client.query("select pg_backend_pid() as pid");
  return Object.assign(client, { pid: rows[0].pid as number }) as Party;
}

/** This backend is stopped on a lock that `holder` has. */
const waitingOn = (pid: number, holder: number) =>
  vi.waitFor(
    async () => {
      const { rows } = await owner.db.execute<{ wait: string; holders: number[] }>(sql`
        select wait_event_type as wait, pg_blocking_pids(pid) as holders
        from pg_stat_activity where pid = ${pid}`);
      expect(rows[0].wait).toBe("Lock");
      expect(rows[0].holders).toContain(holder);
    },
    { timeout: 5_000, interval: 20 },
  );

const hangUp = (...parties: PoolClient[]) => {
  for (const party of parties) party.release(true);
};

const statusOf = async (sessionId: string) =>
  (await owner.db.select().from(tableSessions).where(eq(tableSessions.id, sessionId)))[0].status;

describe("the closure gate", () => {
  it.each(["placed", "cooking", "done"] as const)(
    "refuses a direct close as app_tenant while an item is %s",
    async (status) => {
      const r = await orderingRestaurant(owner.db);
      const { sessionId } = await sessionWith(r, ["delivered", status, "voided"]);
      const tenant = await aTenant(r.restaurantId);
      try {
        expect(await outcome(tenant.query(CLOSE, [sessionId]))).toBe(GATE);
        await tenant.query("rollback");
      } finally {
        hangUp(tenant);
      }
      expect(await statusOf(sessionId)).toBe("open");
    },
  );

  it("refuses it whoever runs it: the owner role, which RLS skips, and with every close reason", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await sessionWith(r, ["placed"]);
    for (const closeReason of ["staff_clear", "idle_expiry", "force_close", "in_app_payment", "pos_payment"] as const) {
      expect(
        await outcome(
          owner.db
            .update(tableSessions)
            .set({ status: "closed", closedAt: new Date(), closeReason })
            .where(eq(tableSessions.id, sessionId)),
        ),
      ).toBe(GATE);
    }
    expect(await statusOf(sessionId)).toBe("open");
  });

  it.each(["placed", "cooking", "done"] as const)(
    "refuses a direct close as app_system, the job's login, which bypasses RLS and can't read the lines, while an item is %s (6.8)",
    async (status) => {
      const r = await orderingRestaurant(owner.db);
      const { sessionId } = await sessionWith(r, ["delivered", status]);
      expect(
        await outcome(
          system.db.execute(sql`
            update table_sessions set status = 'closed', closed_at = now(), close_reason = 'idle_expiry'
            where restaurant_id = ${r.restaurantId} and id = ${sessionId} and status = 'open'`),
        ),
      ).toBe(GATE);
      expect(await statusOf(sessionId)).toBe("open");
    },
  );

  it("lets a session close once every item is delivered or voided, or when it has none", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await sessionWith(r, ["delivered", "voided"]);
    const tenant = await aTenant(r.restaurantId);
    try {
      expect(await outcome(tenant.query(CLOSE, [sessionId]))).toBe("passed");
      await tenant.query("commit");
    } finally {
      hangUp(tenant);
    }
    expect(await statusOf(sessionId)).toBe("closed");

    const empty = await orderingRestaurant(owner.db);
    const [{ id }] = await owner.db
      .insert(tableSessions)
      .values({ restaurantId: empty.restaurantId, tableId: empty.tableId })
      .returning({ id: tableSessions.id });
    await owner.db.execute(sql.raw(CLOSE.replace("$1", `'${id}'`)));
    expect(await statusOf(id)).toBe("closed");
  });

  it("counts only the session's own items: another session's undelivered item doesn't hold it", async () => {
    const r = await orderingRestaurant(owner.db);
    const other = await orderingRestaurant(owner.db);
    await sessionWith(other, ["placed"]);
    const { sessionId } = await sessionWith(r, ["delivered"]);

    expect(await outcome(owner.db.execute(sql.raw(CLOSE.replace("$1", `'${sessionId}'`))))).toBe("passed");
  });

  it("lets voiding the outstanding items then closing, in one transaction, pass: force-close's shape", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, orderId } = await sessionWith(r, ["placed", "done"]);
    const tenant = await aTenant(r.restaurantId);
    try {
      await tenant.query(
        `update order_items set status = 'voided', void_reason = 'Force-close', voided_by = $2
         where order_id = $1 and in_play`,
        [orderId, r.staffId],
      );
      expect(await outcome(tenant.query(CLOSE, [sessionId]))).toBe("passed");
      await tenant.query("commit");
    } finally {
      hangUp(tenant);
    }
    expect(await statusOf(sessionId)).toBe("closed");
  });

  it("refuses a close under REPEATABLE READ, whose snapshot could miss an item committed meanwhile", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId } = await sessionWith(r, ["delivered"]);
    const tenant = await aTenant(r.restaurantId, "repeatable read");
    try {
      expect(await outcome(tenant.query(CLOSE, [sessionId]))).toBe(GATE);
      await tenant.query("rollback");
    } finally {
      hangUp(tenant);
    }
    expect(await statusOf(sessionId)).toBe("open");
  });
});

describe("the closure gate and an item going in at the same time", () => {
  const LINE = `insert into order_items (restaurant_id, order_id, menu_item_id, name_snapshot, quantity, unit_price_usd)
    values ($1, $2, $3, 'Beef stew', 1, 8)`;

  it("an item in first makes the close wait, and the close is then refused", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, orderId } = await sessionWith(r, ["delivered"]);
    const ordering = await aTenant(r.restaurantId);
    const closing = await aTenant(r.restaurantId);
    try {
      await ordering.query(LINE, [r.restaurantId, orderId, r.itemId]);

      const closed = outcome(closing.query(CLOSE, [sessionId]));
      await waitingOn(closing.pid, ordering.pid);
      await ordering.query("commit");

      expect(await closed).toBe(GATE);
      await closing.query("rollback");
    } finally {
      hangUp(ordering, closing);
    }
    expect(await statusOf(sessionId)).toBe("open");
    const lines = await owner.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(lines.map((line) => line.status).sort()).toEqual(["delivered", "placed"]);
  });

  it("a close in first makes the item wait, and the item is then refused: never both", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, orderId } = await sessionWith(r, ["delivered"]);
    const closing = await aTenant(r.restaurantId);
    const ordering = await aTenant(r.restaurantId);
    try {
      expect(await outcome(closing.query(CLOSE, [sessionId]))).toBe("passed");

      const line = outcome(ordering.query(LINE, [r.restaurantId, orderId, r.itemId]));
      await waitingOn(ordering.pid, closing.pid);
      await closing.query("commit");

      expect(await line).toBe(SESSION_CLOSED);
      await ordering.query("rollback");
    } finally {
      hangUp(closing, ordering);
    }
    expect(await statusOf(sessionId)).toBe("closed");
    const lines = await owner.db.select().from(orderItems).where(eq(orderItems.orderId, orderId));
    expect(lines.map((line) => line.status)).toEqual(["delivered"]);
  });

  it("under SERIALIZABLE, an item committed after the close's snapshot still can't slip past it", async () => {
    const r = await orderingRestaurant(owner.db);
    const { sessionId, orderId } = await sessionWith(r, ["delivered"]);
    const closing = await aTenant(r.restaurantId, "serializable");
    const ordering = await aTenant(r.restaurantId, "serializable");
    try {
      // The close's snapshot is taken before the item exists.
      await closing.query("select 1 from table_sessions where id = $1", [sessionId]);
      await ordering.query(LINE, [r.restaurantId, orderId, r.itemId]);
      await ordering.query("commit");

      const closed = await outcome(
        closing.query(CLOSE, [sessionId]).then(() => closing.query("commit")),
      );
      expect(closed).not.toBe("passed");
      await closing.query("rollback").catch(() => undefined);
    } finally {
      hangUp(closing, ordering);
    }
    expect(await statusOf(sessionId)).toBe("open");
  });
});
