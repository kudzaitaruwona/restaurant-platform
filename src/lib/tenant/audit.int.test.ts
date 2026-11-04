import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog } from "@/db/schema";
import { openOwnerDatabase, testDatabaseSettings } from "../../../test/integration/database";
import { devIdentities } from "./dev-identities";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

const [aOwner, , bOwner] = devIdentities;
const owner = openOwnerDatabase();
afterAll(async () => {
  await owner.pool.end();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
  vi.stubEnv("NODE_ENV", "test");
});

async function modules() {
  vi.resetModules();
  const [{ withTenant }, { recordAudit }] = await Promise.all([
    import("@/lib/tenant"),
    import("@/lib/tenant/audit"),
  ]);
  return { withTenant, recordAudit };
}

const ctx = { restaurantId: aOwner.restaurantId, staffId: aOwner.staffId };
const entityId = () => crypto.randomUUID();

const rowFor = async (action: string) =>
  (await owner.db.select().from(auditLog).where(eq(auditLog.action, action)))[0];

describe("recordAudit", () => {
  it("records a platform admin inside a tenant as one, never by the shadow row (S-29)", async () => {
    const { withTenant, recordAudit } = await modules();
    const action = `test.inside.${crypto.randomUUID()}`;
    const platformAdminId = crypto.randomUUID();

    await withTenant(ctx, (tx) =>
      recordAudit(tx, { ...ctx, platformAdminId }, {
        action,
        entityType: "staff",
        entityId: entityId(),
      }),
    );

    expect(await rowFor(action)).toMatchObject({
      actorType: "platform_admin",
      actorId: platformAdminId,
    });
  });

  it("writes an entry for the signed-in staff member, in the tenant from the context", async () => {
    const { withTenant, recordAudit } = await modules();
    const action = `test.staff.${crypto.randomUUID()}`;
    const id = entityId();

    await withTenant(ctx, (tx) =>
      recordAudit(tx, ctx, {
        action,
        entityType: "staff",
        entityId: id,
        details: { role: "owner" },
      }),
    );

    expect(await rowFor(action)).toMatchObject({
      restaurantId: aOwner.restaurantId,
      actorType: "staff",
      actorId: aOwner.staffId,
      entityType: "staff",
      entityId: id,
      details: { role: "owner" },
    });
  });

  it("records another kind of actor when the caller names one", async () => {
    const { withTenant, recordAudit } = await modules();
    const action = `test.admin.${crypto.randomUUID()}`;
    const adminId = entityId();

    await withTenant(ctx, async (tx) => {
      await recordAudit(tx, ctx, {
        action,
        entityType: "restaurant",
        entityId: ctx.restaurantId,
        actor: { type: "platform_admin", id: adminId },
      });
    });

    expect(await rowFor(action)).toMatchObject({
      actorType: "platform_admin",
      actorId: adminId,
      details: {},
    });
  });

  it("is part of the caller's transaction: a rollback leaves no entry", async () => {
    const { withTenant, recordAudit } = await modules();
    const action = `test.rollback.${crypto.randomUUID()}`;

    await expect(
      withTenant(ctx, async (tx) => {
        await recordAudit(tx, ctx, { action, entityType: "x", entityId: entityId() });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await rowFor(action)).toBeUndefined();
  });

  it("can't write into a tenant other than the one the transaction is scoped to", async () => {
    const { withTenant, recordAudit } = await modules();
    await expect(
      withTenant(ctx, (tx) =>
        recordAudit(
          tx,
          { restaurantId: bOwner.restaurantId, staffId: bOwner.staffId },
          { action: "test.cross", entityType: "x", entityId: entityId() },
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("recordAdminAction", () => {
  const entry = (action: string) => ({
    action,
    entityType: "restaurant",
    entityId: aOwner.restaurantId,
  });

  it("writes nothing for staff: the change isn't on spec 01's audit list", async () => {
    vi.resetModules();
    const { withTenant } = await import("@/lib/tenant");
    const { recordAdminAction } = await import("@/lib/tenant/audit");
    const action = `test.staff-edit.${crypto.randomUUID()}`;

    await withTenant(ctx, (tx) => recordAdminAction(tx, ctx, entry(action)));

    expect(await rowFor(action)).toBeUndefined();
  });

  it("writes an entry for a platform admin", async () => {
    vi.resetModules();
    const { withTenant } = await import("@/lib/tenant");
    const { recordAdminAction } = await import("@/lib/tenant/audit");
    const action = `test.admin-edit.${crypto.randomUUID()}`;
    const platformAdminId = crypto.randomUUID();

    await withTenant(ctx, (tx) =>
      recordAdminAction(tx, { ...ctx, platformAdminId }, entry(action)),
    );

    expect(await rowFor(action)).toMatchObject({
      actorType: "platform_admin",
      actorId: platformAdminId,
    });
  });
});
