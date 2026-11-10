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
 * A scan, as the table page's script makes it (spec 06): the token opens the
 * table's session, or joins the one already open. Against a real Postgres as
 * app_tenant.
 */
const owner = openOwnerDatabase();

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

const scan = (qrToken: string) =>
  POST(new Request(`http://localhost/api/t/${qrToken}/session`, { method: "POST" }), {
    params: Promise.resolve({ qrToken }),
  });

const joined = async (qrToken: string) => {
  const response = await scan(qrToken);
  expect(response.status).toBe(200);
  return (await response.json()).session as string;
};

describe("POST /api/t/[qrToken]/session", () => {
  it("opens a session on a free table, with no approval (S-36)", async () => {
    const { qrToken, tableId, restaurantId } = await orderingRestaurant(owner.db);

    const session = await joined(qrToken);

    expect(await sessionsOf(owner.db, tableId)).toEqual([
      expect.objectContaining({ id: session, restaurantId, status: "open", approvedAt: null }),
    ]);
  });

  it("joins the open session, and bumps its last activity", async () => {
    const { qrToken, tableId } = await orderingRestaurant(owner.db);
    const first = await joined(qrToken);
    await owner.db
      .update(tableSessions)
      .set({ lastActivityAt: sql`now() - interval '30 minutes'` })
      .where(eq(tableSessions.id, first));

    const second = await joined(qrToken);

    expect(second).toBe(first);
    const [session] = await sessionsOf(owner.db, tableId);
    expect(Date.now() - session.lastActivityAt.getTime()).toBeLessThan(60_000);
  });

  it("opens a fresh session once the last one has closed", async () => {
    const { qrToken, tableId } = await orderingRestaurant(owner.db);
    const first = await joined(qrToken);
    await owner.db
      .update(tableSessions)
      .set({ status: "closed", closedAt: new Date(), closeReason: "staff_clear" })
      .where(eq(tableSessions.id, first));

    const second = await joined(qrToken);

    expect(second).not.toBe(first);
    expect((await sessionsOf(owner.db, tableId)).map((s) => s.status)).toEqual(["closed", "open"]);
  });

  it("puts two phones scanning a free table at the same moment in the same session", async () => {
    const { qrToken, tableId } = await orderingRestaurant(owner.db);

    const sessions = await Promise.all(Array.from({ length: 8 }, () => joined(qrToken)));

    expect(new Set(sessions).size).toBe(1);
    expect(await sessionsOf(owner.db, tableId)).toHaveLength(1);
  });

  it("the loser of the insert race joins the winner's session rather than erroring", async () => {
    const { qrToken, tableId, restaurantId } = await orderingRestaurant(owner.db);
    const winner = crypto.randomUUID();
    let loser: Promise<Response> | undefined;

    // The winner's insert is in flight, uncommitted, while the loser's arrives:
    // the loser has to wait on the table lock, then take the winner's session.
    await owner.db.transaction(async (tx) => {
      await tx.insert(tableSessions).values({ id: winner, restaurantId, tableId });
      loser = scan(qrToken);
      // Long enough for the loser to reach the index and wait on it.
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    const response = await loser!;
    expect(response.status).toBe(200);
    expect((await response.json()).session).toBe(winner);
    expect(await sessionsOf(owner.db, tableId)).toHaveLength(1);
  });

  it("is a 404 for an unknown token, a NUL, or another kind of token, and opens nothing", async () => {
    const { restaurantId } = await orderingRestaurant(owner.db);
    for (const token of ["no-such-token", mintQrToken(), "\0", `ordering-${restaurantId}`]) {
      expect((await scan(token)).status).toBe(404);
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

    expect((await scan(archived.qrToken)).status).toBe(404);
    expect((await scan(regenerated.qrToken)).status).toBe(404);
    expect(await sessionsOf(owner.db, archived.tableId)).toEqual([]);
    expect(await sessionsOf(owner.db, regenerated.tableId)).toEqual([]);
  });

  it("is never stored by a cache", async () => {
    const { qrToken } = await orderingRestaurant(owner.db);
    expect((await scan(qrToken)).headers.get("cache-control")).toBe("no-store");
  });
});
