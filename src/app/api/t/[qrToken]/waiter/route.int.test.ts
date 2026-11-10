import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { diningTables, tableSessions } from "@/db/schema";
import { mintQrToken } from "@/lib/qr-token";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../../test/integration/database";
import { orderingRestaurant, sessionsOf } from "../../../../../../test/integration/ordering";
import { POST } from "./route";

/**
 * "Call a waiter" (spec 06, step 4, proposed), as the table page's script makes
 * it: the token flags the table's open session, opening or joining one as a scan
 * does. Against a real Postgres as app_tenant.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const call = (qrToken: string) =>
  POST(new Request(`http://localhost/api/t/${qrToken}/waiter`, { method: "POST" }), {
    params: Promise.resolve({ qrToken }),
  });

describe("POST /api/t/[qrToken]/waiter", () => {
  it("flags the open session, and says which and since when", async () => {
    const { qrToken, tableId, restaurantId } = await orderingRestaurant(owner.db);
    const [opened] = await owner.db
      .insert(tableSessions)
      .values({ restaurantId, tableId })
      .returning();

    const response = await call(qrToken);

    expect(response.status).toBe(200);
    const [session] = await sessionsOf(owner.db, tableId);
    expect(session.id).toBe(opened.id);
    expect(session.waiterRequestedAt).toBeInstanceOf(Date);
    expect(await response.json()).toEqual({
      session: opened.id,
      requestedAt: session.waiterRequestedAt!.toISOString(),
    });
  });

  it("opens a session on a free table, as a scan would, flagged", async () => {
    const { qrToken, tableId, restaurantId } = await orderingRestaurant(owner.db);

    expect((await call(qrToken)).status).toBe(200);

    expect(await sessionsOf(owner.db, tableId)).toEqual([
      expect.objectContaining({ restaurantId, status: "open", waiterRequestedAt: expect.any(Date) }),
    ]);
  });

  it("is activity for the session", async () => {
    const { qrToken, tableId } = await orderingRestaurant(owner.db);
    await call(qrToken);
    await owner.db
      .update(tableSessions)
      .set({ lastActivityAt: sql`now() - interval '30 minutes'` })
      .where(eq(tableSessions.tableId, tableId));

    await call(qrToken);

    const [session] = await sessionsOf(owner.db, tableId);
    expect(Date.now() - session.lastActivityAt.getTime()).toBeLessThan(60_000);
  });

  it("doesn't stack: a call already pending stays pending, with its first time", async () => {
    const { qrToken, tableId } = await orderingRestaurant(owner.db);
    const first = await (await call(qrToken)).json();

    const calls = await Promise.all(Array.from({ length: 5 }, () => call(qrToken)));

    for (const response of calls) expect((await response.json()).requestedAt).toBe(first.requestedAt);
    const sessions = await sessionsOf(owner.db, tableId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].waiterRequestedAt!.toISOString()).toBe(first.requestedAt);
  });

  it("can be called again once staff have dismissed it", async () => {
    const { qrToken, tableId } = await orderingRestaurant(owner.db);
    await call(qrToken);
    await owner.db
      .update(tableSessions)
      .set({ waiterRequestedAt: null })
      .where(eq(tableSessions.tableId, tableId));

    const again = await (await call(qrToken)).json();

    expect(again.requestedAt).toEqual(expect.any(String));
  });

  it("is a 404 for an unknown token, a NUL, or another kind of token, and flags nothing", async () => {
    const { restaurantId } = await orderingRestaurant(owner.db);
    for (const token of ["no-such-token", mintQrToken(), "\0", `ordering-${restaurantId}`]) {
      expect((await call(token)).status).toBe(404);
    }
  });

  it("is a 404 for an archived table's token, and for a regenerated one, and opens nothing", async () => {
    const archived = await orderingRestaurant(owner.db);
    await owner.db
      .update(diningTables)
      .set({ archivedAt: new Date() })
      .where(eq(diningTables.id, archived.tableId));
    const regenerated = await orderingRestaurant(owner.db);
    await owner.db
      .update(diningTables)
      .set({ qrToken: mintQrToken() })
      .where(eq(diningTables.id, regenerated.tableId));

    expect((await call(archived.qrToken)).status).toBe(404);
    expect((await call(regenerated.qrToken)).status).toBe(404);
    expect(await sessionsOf(owner.db, archived.tableId)).toEqual([]);
    expect(await sessionsOf(owner.db, regenerated.tableId)).toEqual([]);
  });

  it("is never stored by a cache", async () => {
    const { qrToken } = await orderingRestaurant(owner.db);
    expect((await call(qrToken)).headers.get("cache-control")).toBe("no-store");
  });
});
