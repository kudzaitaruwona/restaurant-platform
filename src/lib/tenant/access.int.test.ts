import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  adminAuthUser,
  auditLog,
  categories,
  menuItems,
  restaurants,
  staff,
  staffAuthUser,
} from "@/db/schema";
import { signIn } from "../../../test/integration/auth";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
import { installFakeServices } from "../../../test/integration/fake-services";
import { statusOf } from "../../../test/integration/http";
import {
  devIdentities,
  devPlatformAdmin,
  findDevIdentity,
} from "./dev-identities";

/**
 * The cross-tenant and role harness (spec 01 › Tenant isolation). Each route
 * goes in `routes` below. The tests then hold it to the rules: restaurant A's
 * context gets a 404 or 403 on restaurant B's resources, and a staff context
 * gets a 403 on anything owner-only. A route handler that isn't listed fails
 * the coverage test, so a new one can't skip the harness. Platform-admin routes
 * go in `adminRoutes`: no restaurant identity gets past them, on anyone's IDs.
 * Every tenant route also runs as a platform admin who has entered restaurant A:
 * the same walls apply, and every write has to reach audit_log as that admin.
 *
 * Handlers run for real against Postgres, as the RLS-bound role, and every
 * identity below is a real session: signed in through the real endpoints with
 * the dev bypass off. `next/headers` is faked only to hand a handler the request
 * that identity's browser would send.
 */
const session = vi.hoisted(() => ({
  identity: "",
  signedIn: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ cookie: session.signedIn.get(session.identity) ?? "" }),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: Promise<unknown>) => task,
}));

// Only a real request has a cache to revalidate.
vi.mock("next/cache", () => ({
  cacheLife: () => {},
  cacheTag: () => {},
  revalidateTag: () => {},
}));

/** What a route acts on: an existing resource in some restaurant. */
type Target = {
  staffId: string;
  categoryId: string;
  /** A second live category: where archiving a category moves its items. */
  spareCategoryId: string;
  itemId: string;
};

type TenantRoute = {
  name: string;
  ownerOnly: boolean;
  call: (target: Target) => Promise<Response>;
};

const harnessItem = "Harness item";
const harnessCategory = "Harness category";
const renamedByHarness = "Renamed by the harness";

const staffRoute = () => import("@/app/api/staff/[staffId]/route");
const staffParams = ({ staffId }: Target) => ({
  params: Promise.resolve({ staffId }),
});
const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};
const request = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(new URL(path, "http://localhost:3000"), init);

const routes: TenantRoute[] = [
  {
    name: "GET /api/staff/[staffId]",
    ownerOnly: false,
    call: async (target) =>
      (await staffRoute()).GET(
        request(`/api/staff/${target.staffId}`),
        staffParams(target),
      ),
  },
  {
    name: "POST /api/staff/[staffId]",
    ownerOnly: true,
    call: async (target) =>
      (await staffRoute()).POST(
        request(`/api/staff/${target.staffId}`, {
          method: "POST",
          body: form({ displayName: "Renamed by the harness" }),
        }),
        staffParams(target),
      ),
  },
  {
    name: "POST /api/staff/[staffId]/deactivate",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/staff/[staffId]/deactivate/route")).POST(
        request(`/api/staff/${target.staffId}/deactivate`, { method: "POST" }),
        staffParams(target),
      ),
  },
  {
    name: "POST /api/staff/[staffId]/role",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/staff/[staffId]/role/route")).POST(
        request(`/api/staff/${target.staffId}/role`, {
          method: "POST",
          body: form({ role: "owner" }),
        }),
        staffParams(target),
      ),
  },
  {
    // The id is in the form rather than the URL, because the form chooses it.
    name: "POST /api/menu/items",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/items/route")).POST(
        request("/api/menu/items", {
          method: "POST",
          body: form({
            name: harnessItem,
            description: "",
            priceUsd: "8.50",
            categoryId: target.categoryId,
          }),
        }),
      ),
  },
  {
    name: "POST /api/menu/categories/[categoryId]",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/categories/[categoryId]/route")).POST(
        request(`/api/menu/categories/${target.categoryId}`, {
          method: "POST",
          body: form({ name: renamedByHarness }),
        }),
        { params: Promise.resolve({ categoryId: target.categoryId }) },
      ),
  },
  {
    name: "POST /api/menu/categories/[categoryId]/archive",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/categories/[categoryId]/archive/route")).POST(
        request(`/api/menu/categories/${target.categoryId}/archive`, {
          method: "POST",
          body: form({ moveItemsTo: target.spareCategoryId }),
        }),
        { params: Promise.resolve({ categoryId: target.categoryId }) },
      ),
  },
  {
    // The ids are in the form, like the item's category.
    name: "POST /api/menu/categories/order",
    ownerOnly: true,
    call: async (target) => {
      const body = new FormData();
      body.append("ids", target.categoryId);
      body.append("ids", target.spareCategoryId);
      return (await import("@/app/api/menu/categories/order/route")).POST(
        request("/api/menu/categories/order", { method: "POST", body }),
      );
    },
  },
  {
    name: "POST /api/menu/items/[itemId]",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/items/[itemId]/route")).POST(
        request(`/api/menu/items/${target.itemId}`, {
          method: "POST",
          body: form({
            name: renamedByHarness,
            description: "",
            priceUsd: "9.00",
            sortOrder: "0",
            categoryId: target.categoryId,
          }),
        }),
        { params: Promise.resolve({ itemId: target.itemId }) },
      ),
  },
  {
    name: "POST /api/menu/items/[itemId]/archive",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/items/[itemId]/archive/route")).POST(
        request(`/api/menu/items/${target.itemId}/archive`, { method: "POST" }),
        { params: Promise.resolve({ itemId: target.itemId }) },
      ),
  },
];

/**
 * Routes with no id in them: they act on the session's own restaurant, so
 * there's no B resource to aim at. What's left to prove is in "routes that take
 * no id" below: the role check, and that smuggled ids change nothing.
 */
type SessionRoute = {
  name: string;
  call: (fields?: Record<string, string>, init?: { path?: string; headers?: Record<string, string> }) => Promise<Response>;
};

const addedEmailPrefix = "harness-added-";

const sessionRoutes: SessionRoute[] = [
  {
    name: "POST /api/restaurant",
    call: async (fields, init) =>
      (await import("@/app/api/restaurant/route")).POST(
        request(init?.path ?? "/api/restaurant", {
          method: "POST",
          headers: init?.headers,
          // Restaurant A's seeded values: other test files read them.
          body: form({
            name: "Restaurant A",
            contactPhone: "",
            wifiName: "",
            wifiPassword: "",
            currencyMode: "usd_primary",
            timezone: "Africa/Harare",
            ...fields,
          }),
        }),
      ),
  },
  {
    name: "POST /api/staff",
    call: async (fields, init) =>
      (await import("@/app/api/staff/route")).POST(
        request(init?.path ?? "/api/staff", {
          method: "POST",
          headers: init?.headers,
          body: form({
            email: `${addedEmailPrefix}${crypto.randomUUID()}@example.test`,
            displayName: "Added by the harness",
            role: "staff",
            ...fields,
          }),
        }),
      ),
  },
  {
    name: "POST /api/menu/categories",
    call: async (fields, init) =>
      (await import("@/app/api/menu/categories/route")).POST(
        request(init?.path ?? "/api/menu/categories", {
          method: "POST",
          headers: init?.headers,
          body: form({ name: harnessCategory, ...fields }),
        }),
      ),
  },
];

/**
 * Routes with no session at all, where the token is the only tenant input (spec
 * 01). There's no identity to refuse: what's left to prove is that nothing else
 * in the request can choose a tenant, in "public routes" below.
 */
type PublicRoute = {
  name: string;
  call: (
    token: string,
    init?: { query?: string; headers?: Record<string, string> },
  ) => Promise<Response>;
};

const publicRoutes: PublicRoute[] = [
  {
    name: "GET /m/[menuToken]",
    call: async (menuToken, init) =>
      (await import("@/app/m/[menuToken]/route")).GET(
        request(`/m/${menuToken}${init?.query ?? ""}`, { headers: init?.headers }),
        { params: Promise.resolve({ menuToken }) },
      ),
  },
];

type AdminRoute = {
  name: string;
  call: (restaurantId: string) => Promise<Response>;
};

const HARNESS_SLUG_PREFIX = "harness-";

const adminRoutes: AdminRoute[] = [
  {
    name: "POST /api/admin/restaurants",
    call: async () =>
      (await import("@/app/api/admin/restaurants/route")).POST(
        request("/api/admin/restaurants", {
          method: "POST",
          body: form({
            name: "Created by the harness",
            slug: `${HARNESS_SLUG_PREFIX}${crypto.randomUUID()}`,
            currencyMode: "usd_only",
          }),
        }),
      ),
  },
  {
    name: "POST /api/admin/restaurants/[restaurantId]/owner",
    call: async (restaurantId) =>
      (await import("@/app/api/admin/restaurants/[restaurantId]/owner/route")).POST(
        request(`/api/admin/restaurants/${restaurantId}/owner`, {
          method: "POST",
          body: form({
            email: `${crypto.randomUUID()}@example.test`,
            displayName: "Owner by the harness",
          }),
        }),
        { params: Promise.resolve({ restaurantId }) },
      ),
  },
  {
    name: "POST /api/admin/restaurants/[restaurantId]/enter",
    call: async (restaurantId) =>
      (await import("@/app/api/admin/restaurants/[restaurantId]/enter/route")).POST(
        request(`/api/admin/restaurants/${restaurantId}/enter`, { method: "POST" }),
        { params: Promise.resolve({ restaurantId }) },
      ),
  },
  {
    name: "POST /api/admin/leave",
    call: async () =>
      (await import("@/app/api/admin/leave/route")).POST(),
  },
];

const [enterRoute, leaveRoute] = adminRoutes.slice(-2);

/** Holds no tenant data: tested in src/app/api/dev/identity/route.int.test.ts. */
const outsideTheHarness = [
  "POST /api/dev/identity",
  // Sign-in itself, before any tenant: src/lib/auth/auth.int.test.ts.
  "GET /api/auth/[audience]/[...all]",
  "POST /api/auth/[audience]/[...all]",
];

const [aOwner, aStaff, bOwner, bStaff] = devIdentities;
const restaurantAIdentities = [aOwner, aStaff];

const owner = openOwnerDatabase();

// The harness writes, so it writes to rows of its own and leaves the seed alone.
const fixtures = {
  a: {
    staffId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    spareCategoryId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    restaurantId: aOwner.restaurantId,
  },
  b: {
    staffId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    spareCategoryId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    restaurantId: bOwner.restaurantId,
  },
};
const fixtureName = "Harness fixture";
/** The menu fixtures before any route touched them. */
const pristine = {} as Record<"a" | "b", Awaited<ReturnType<typeof menuFixtureState>>>;
const emailOf = (key: string) => `${key}@dev.example.test`;

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "");
  const services = installFakeServices();
  for (const { key } of devIdentities) {
    session.signedIn.set(key, await signIn(services, "staff", emailOf(key)));
  }
  session.signedIn.set(
    devPlatformAdmin.key,
    await signIn(services, "admin", devPlatformAdmin.email),
  );
  await owner.db.insert(staff).values(
    Object.values(fixtures).map(({ staffId, restaurantId }) => ({
      id: staffId,
      restaurantId,
      email: `${staffId}@example.test`,
      displayName: fixtureName,
    })),
  );
  await owner.db.insert(categories).values(
    Object.values(fixtures).flatMap(({ categoryId, spareCategoryId, restaurantId }) =>
      [categoryId, spareCategoryId].map((id) => ({
        id,
        restaurantId,
        name: fixtureName,
      })),
    ),
  );
  await owner.db.insert(menuItems).values(
    Object.values(fixtures).map(({ itemId, categoryId, restaurantId }) => ({
      id: itemId,
      restaurantId,
      categoryId,
      name: fixtureName,
      priceUsd: "8.50",
    })),
  );
  pristine.a = await menuFixtureState(fixtures.a);
  pristine.b = await menuFixtureState(fixtures.b);
});

afterEach(async () => {
  await owner.db
    .update(staff)
    .set({ displayName: fixtureName, role: "staff", active: true })
    .where(eq(staff.id, fixtures.a.staffId));
  await resetMenuFixtures();
});

afterAll(async () => {
  for (const { staffId } of Object.values(fixtures)) {
    await owner.db.delete(staff).where(eq(staff.id, staffId));
  }
  await owner.db
    .delete(menuItems)
    .where(inArray(menuItems.name, [harnessItem, fixtureName]));
  await owner.db
    .delete(categories)
    .where(inArray(categories.name, [fixtureName, harnessCategory]));
  // Restaurants created here stay behind: one with an owner can't lose it (S-26).
  await owner.db.delete(staff).where(like(staff.email, `${addedEmailPrefix}%`));
  await owner.db.delete(staffAuthUser).where(
    inArray(
      staffAuthUser.email,
      devIdentities.map(({ key }) => emailOf(key)),
    ),
  );
  await owner.db
    .delete(adminAuthUser)
    .where(eq(adminAuthUser.email, devPlatformAdmin.email));
  await owner.pool.end();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Puts the menu fixtures back as they were: the routes rename and archive them. */
async function resetMenuFixtures() {
  const all = Object.values(fixtures);
  await owner.db
    .update(categories)
    .set({ name: fixtureName, archivedAt: null, sortOrder: 0 })
    .where(inArray(categories.id, all.flatMap((f) => [f.categoryId, f.spareCategoryId])));
  await owner.db
    .update(menuItems)
    .set({ name: fixtureName, archivedAt: null, priceUsd: "8.50" })
    .where(inArray(menuItems.id, all.map((f) => f.itemId)));
  for (const { itemId, categoryId } of all) {
    await owner.db.update(menuItems).set({ categoryId }).where(eq(menuItems.id, itemId));
  }
}

/** What the menu routes would change in a fixture's restaurant. */
const menuFixtureState = async ({ categoryId, spareCategoryId, itemId }: Target) => {
  const rows = await owner.db
    .select({ id: categories.id, name: categories.name, archivedAt: categories.archivedAt, sortOrder: categories.sortOrder })
    .from(categories)
    .where(inArray(categories.id, [categoryId, spareCategoryId]));
  const [item] = await owner.db
    .select({ name: menuItems.name, categoryId: menuItems.categoryId, archivedAt: menuItems.archivedAt })
    .from(menuItems)
    .where(eq(menuItems.id, itemId));
  return { categories: rows.sort((x, y) => x.id.localeCompare(y.id)), item };
};

const displayName = async (staffId: string) => {
  const [row] = await owner.db
    .select({ displayName: staff.displayName })
    .from(staff)
    .where(eq(staff.id, staffId));
  return row.displayName;
};

const harnessRestaurants = () =>
  owner.db
    .select({ id: restaurants.id })
    .from(restaurants)
    .where(like(restaurants.slug, `${HARNESS_SLUG_PREFIX}%`));

const staffCount = async (restaurantId: string) =>
  (
    await owner.db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.restaurantId, restaurantId))
  ).length;

/** A restaurant with nobody in it yet: the state the admin routes work on. */
const emptyRestaurant = async () => {
  const id = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id,
    name: "Harness restaurant",
    slug: `${HARNESS_SLUG_PREFIX}${id}`,
    menuToken: `harness-${id}`,
    currencyMode: "usd_only",
  });
  return id;
};

/** What the staff management routes would change. */
const standing = async (staffId: string) => {
  const [row] = await owner.db
    .select({ role: staff.role, active: staff.active })
    .from(staff)
    .where(eq(staff.id, staffId));
  return row;
};
const untouched = { role: "staff", active: true };

const restaurantRow = async (restaurantId: string) => {
  const [row] = await owner.db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, restaurantId));
  return row;
};

/** What the menu routes would change, in any restaurant. */
const harnessItems = (restaurantId: string) =>
  owner.db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(eq(menuItems.restaurantId, restaurantId), eq(menuItems.name, harnessItem)),
    );

const harnessCategories = (restaurantId: string) =>
  owner.db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.restaurantId, restaurantId),
        eq(categories.name, harnessCategory),
      ),
    );

const addedStaff = () =>
  owner.db
    .select({ restaurantId: staff.restaurantId, displayName: staff.displayName })
    .from(staff)
    .where(like(staff.email, `${addedEmailPrefix}%`));

const each = (identities: typeof restaurantAIdentities) =>
  routes.flatMap((route) =>
    identities.map((identity) => [route.name, identity.key, route, identity] as const),
  );

describe("cross-tenant access", () => {
  it.each(each(restaurantAIdentities))(
    "%s: %s gets a 404 or 403 on restaurant B's resource and changes nothing",
    async (_name, key, route) => {
      session.identity = key;
      const itemsInA = (await harnessItems(fixtures.a.restaurantId)).length;

      const status = await statusOf(() => route.call(fixtures.b));

      expect([403, 404]).toContain(status);
      expect(await displayName(fixtures.b.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.b.staffId)).toEqual(untouched);
      expect(await harnessItems(fixtures.b.restaurantId)).toEqual([]);
      expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(itemsInA);
      expect(await menuFixtureState(fixtures.b)).toEqual(pristine.b);
    },
  );

  it.each(routes.map((route) => [route.name, route] as const))(
    "%s: the same call reaches restaurant A's resource, so the refusals above mean something",
    async (_name, route) => {
      session.identity = aOwner.key;
      expect(await statusOf(() => route.call(fixtures.a))).toBeLessThan(400);
    },
  );

  it("works both ways: B can't reach A", async () => {
    for (const identity of [bOwner, bStaff]) {
      session.identity = identity.key;
      for (const route of routes) {
        expect([403, 404]).toContain(
          await statusOf(() => route.call(fixtures.a)),
        );
      }
    }
  });
});

describe("no session", () => {
  it.each(routes.map((route) => [route.name, route] as const))(
    "%s: is a 401 and changes nothing",
    async (_name, route) => {
      session.identity = "";
      expect(await statusOf(() => route.call(fixtures.a))).toBe(401);
      expect(await displayName(fixtures.a.staffId)).toBe(fixtureName);
    },
  );
});

describe("request input can't choose the tenant", () => {
  it("a restaurant id in the query, headers or body changes nothing", async () => {
    session.identity = aOwner.key;
    const { GET, POST } = await staffRoute();
    const path = `/api/staff/${fixtures.b.staffId}?restaurantId=${fixtures.b.restaurantId}&restaurant_id=${fixtures.b.restaurantId}`;
    const headers = { "x-restaurant-id": fixtures.b.restaurantId };

    expect(
      await statusOf(() =>
        GET(request(path, { headers }), staffParams(fixtures.b)),
      ),
    ).toBe(404);
    expect(
      await statusOf(() =>
        POST(
          request(path, {
            method: "POST",
            headers,
            body: form({
              displayName: "Hijacked",
              restaurantId: fixtures.b.restaurantId,
            }),
          }),
          staffParams(fixtures.b),
        ),
      ),
    ).toBe(404);
    expect(await displayName(fixtures.b.staffId)).toBe(fixtureName);
  });
});

describe("owner-only routes", () => {
  const ownerOnly = routes.filter((route) => route.ownerOnly);

  it("exist, so this suite tests something", () => {
    expect(ownerOnly).not.toEqual([]);
  });

  it.each(ownerOnly.map((route) => [route.name, route] as const))(
    "%s: a staff context gets a 403 in its own restaurant and changes nothing",
    async (_name, route) => {
      session.identity = aStaff.key;
      const items = (await harnessItems(fixtures.a.restaurantId)).length;

      expect(await statusOf(() => route.call(fixtures.a))).toBe(403);
      expect(await displayName(fixtures.a.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.a.staffId)).toEqual(untouched);
      expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(items);
      expect(await menuFixtureState(fixtures.a)).toEqual(pristine.a);
    },
  );

  it.each(ownerOnly.map((route) => [route.name, route] as const))(
    "%s: an owner gets through",
    async (_name, route) => {
      session.identity = aOwner.key;
      expect(await statusOf(() => route.call(fixtures.a))).toBeLessThan(400);
    },
  );
});

describe("routes that take no id", () => {
  it.each(sessionRoutes.map((route) => [route.name, route] as const))(
    "%s: a staff context gets a 403 and changes nothing",
    async (_name, route) => {
      session.identity = aStaff.key;
      const before = await restaurantRow(aStaff.restaurantId);
      const added = (await addedStaff()).length;
      const newCategories = (await harnessCategories(aStaff.restaurantId)).length;

      expect(
        await statusOf(() => route.call({ contactPhone: "+263771234567" })),
      ).toBe(403);

      expect(await restaurantRow(aStaff.restaurantId)).toEqual(before);
      expect(await addedStaff()).toHaveLength(added);
      expect(await harnessCategories(aStaff.restaurantId)).toHaveLength(newCategories);
    },
  );

  it.each(sessionRoutes.map((route) => [route.name, route] as const))(
    "%s: an owner gets through",
    async (_name, route) => {
      session.identity = aOwner.key;
      expect(await statusOf(() => route.call())).toBeLessThan(400);
    },
  );

  const smuggled = (restaurantId: string) => ({
    fields: { restaurantId, restaurant_id: restaurantId },
    init: {
      headers: { "x-restaurant-id": restaurantId },
      query: `?restaurantId=${restaurantId}&restaurant_id=${restaurantId}`,
    },
  });

  it("settings go to the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const { fields, init } = smuggled(fixtures.b.restaurantId);
    const theirs = await restaurantRow(fixtures.b.restaurantId);
    const [route] = sessionRoutes;

    try {
      const response = await route.call(
        { ...fields, contactPhone: "+263770000001" },
        { headers: init.headers, path: `/api/restaurant${init.query}` },
      );

      expect(response.status).toBeLessThan(400);
      expect(await restaurantRow(fixtures.b.restaurantId)).toEqual(theirs);
      expect(await restaurantRow(fixtures.a.restaurantId)).toMatchObject({
        contactPhone: "+263770000001",
      });
    } finally {
      await owner.db
        .update(restaurants)
        .set({ contactPhone: null })
        .where(eq(restaurants.id, fixtures.a.restaurantId));
    }
  });

  it("a new colleague joins the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const { fields, init } = smuggled(fixtures.b.restaurantId);
    const displayName = `Smuggled ${crypto.randomUUID()}`;

    const response = await sessionRoutes[1].call(
      { ...fields, displayName },
      { headers: init.headers, path: `/api/staff${init.query}` },
    );

    expect(response.status).toBeLessThan(400);
    expect(await addedStaff()).toContainEqual({
      restaurantId: fixtures.a.restaurantId,
      displayName,
    });
  });
});

describe("the menu routes", () => {
  it("a new category joins the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const before = (await harnessCategories(fixtures.a.restaurantId)).length;
    const id = fixtures.b.restaurantId;

    const response = await sessionRoutes[2].call(
      { restaurantId: id, restaurant_id: id },
      {
        headers: { "x-restaurant-id": id },
        path: `/api/menu/categories?restaurantId=${id}&restaurant_id=${id}`,
      },
    );

    expect(response.status).toBeLessThan(400);
    expect(await harnessCategories(fixtures.b.restaurantId)).toEqual([]);
    expect(await harnessCategories(fixtures.a.restaurantId)).toHaveLength(before + 1);
  });

  it("an item with no category chosen is a 400 the form can show", async () => {
    session.identity = aOwner.key;
    const { POST } = await import("@/app/api/menu/items/route");

    const response = await POST(
      request("/api/menu/items", {
        method: "POST",
        body: form({ name: harnessItem, description: "", priceUsd: "8.50", categoryId: "" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a category." });
  });

  it("a new item joins the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const before = (await harnessItems(fixtures.a.restaurantId)).length;
    const id = fixtures.b.restaurantId;
    const { POST } = await import("@/app/api/menu/items/route");

    const response = await POST(
      request(`/api/menu/items?restaurantId=${id}`, {
        method: "POST",
        headers: { "x-restaurant-id": id },
        body: form({
          name: harnessItem,
          description: "",
          priceUsd: "8.50",
          categoryId: fixtures.a.categoryId,
          restaurantId: id,
          restaurant_id: id,
        }),
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(await harnessItems(fixtures.b.restaurantId)).toEqual([]);
    expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(before + 1);
  });
});

describe("public routes", () => {
  const tokenOf = (restaurant: "a" | "b") => `dev-menu-restaurant-${restaurant}`;
  const eachPublic = publicRoutes.map((route) => [route.name, route] as const);

  it.each(eachPublic)("%s: needs no session", async (_name, route) => {
    session.identity = "";
    expect(await statusOf(() => route.call(tokenOf("a")))).toBe(200);
  });

  it.each(eachPublic)("%s: an unknown token is a 404", async (_name, route) => {
    session.identity = "";
    expect(await statusOf(() => route.call("no-such-token"))).toBe(404);
  });

  it.each(eachPublic)(
    "%s: a restaurant id in the query or headers can't stand in for the token",
    async (_name, route) => {
      session.identity = "";
      const id = fixtures.a.restaurantId;

      expect(
        await statusOf(() =>
          route.call("no-such-token", {
            query: `?restaurantId=${id}&restaurant_id=${id}`,
            headers: { "x-restaurant-id": id },
          }),
        ),
      ).toBe(404);
    },
  );

  it.each(eachPublic)(
    "%s: the token decides the tenant, not the query, the headers or a session",
    async (_name, route) => {
      session.identity = aOwner.key;
      const id = fixtures.a.restaurantId;

      const response = await route.call(tokenOf("b"), {
        query: `?restaurantId=${id}`,
        headers: { "x-restaurant-id": id },
      });

      const page = await response.text();
      expect(page).toContain("Restaurant B");
      expect(page).not.toContain("Restaurant A");
    },
  );
});

describe("the example routes", () => {
  it("an owner can rename a colleague", async () => {
    session.identity = aOwner.key;
    await routes[1].call(fixtures.a);
    expect(await displayName(fixtures.a.staffId)).toBe("Renamed by the harness");
  });

  it("any staff member can read a colleague", async () => {
    session.identity = aStaff.key;
    const response = await routes[0].call(fixtures.a);
    expect(await response.json()).toEqual({
      id: fixtures.a.staffId,
      displayName: fixtureName,
      role: "staff",
    });
  });

  it.each(["not-a-uuid", "", "'; drop table staff; --"])(
    "a malformed id is a 404, not an error: %j",
    async (staffId) => {
      session.identity = aOwner.key;
      for (const route of routes) {
        // A blank category isn't a bad id, it's no choice: see the menu routes.
        const categoryId = staffId || "not-a-uuid";
        const target = { staffId, categoryId, spareCategoryId: `${categoryId}-spare`, itemId: categoryId };
        expect(await statusOf(() => route.call(target))).toBe(404);
      }
    },
  );

  it.each(["", "   ", "x".repeat(201)])(
    "an owner can't set an unusable name: %j",
    async (name) => {
      session.identity = aOwner.key;
      const { POST } = await staffRoute();
      const response = await POST(
        request(`/api/staff/${fixtures.a.staffId}`, {
          method: "POST",
          body: form({ displayName: name }),
        }),
        staffParams(fixtures.a),
      );
      expect(response.status).toBe(400);
      expect(await displayName(fixtures.a.staffId)).toBe(fixtureName);
    },
  );
});

const leave = () => {
  session.identity = devPlatformAdmin.key;
  return leaveRoute.call("");
};

describe("platform-admin routes", () => {
  afterEach(leave);

  const eachStaffIdentity = adminRoutes.flatMap((route) =>
    devIdentities.map(
      (identity) => [route.name, identity.key, route, identity] as const,
    ),
  );

  it.each(eachStaffIdentity)(
    "%s: %s gets a 403 on restaurant B's id and changes nothing",
    async (_name, key, route) => {
      session.identity = key;
      const restaurantsBefore = (await harnessRestaurants()).length;
      const staffBefore = await staffCount(fixtures.b.restaurantId);

      expect(await statusOf(() => route.call(fixtures.b.restaurantId))).toBe(403);

      expect(await harnessRestaurants()).toHaveLength(restaurantsBefore);
      expect(await staffCount(fixtures.b.restaurantId)).toBe(staffBefore);
    },
  );

  it.each(eachStaffIdentity)(
    "%s: %s gets a 403 on an empty restaurant too, the one thing the route would change",
    async (_name, key, route) => {
      session.identity = key;
      const restaurantId = await emptyRestaurant();

      expect(await statusOf(() => route.call(restaurantId))).toBe(403);

      expect(await staffCount(restaurantId)).toBe(0);
    },
  );

  it.each(adminRoutes.map((route) => [route.name, route] as const))(
    "%s: no identity gets a 401",
    async (_name, route) => {
      session.identity = "nobody";
      expect(
        await statusOf(async () => route.call(await emptyRestaurant())),
      ).toBe(401);
    },
  );

  it.each(adminRoutes.map((route) => [route.name, route] as const))(
    "%s: the platform admin gets through, so the refusals above mean something",
    async (_name, route) => {
      session.identity = devPlatformAdmin.key;
      expect(
        await statusOf(async () => route.call(await emptyRestaurant())),
      ).toBeLessThan(400);
    },
  );
});

describe("the platform admin on tenant routes", () => {
  it.each(routes.map((route) => [route.name, route] as const))(
    "%s: a 403 until it enters a restaurant, on any restaurant's id",
    async (_name, route) => {
      session.identity = devPlatformAdmin.key;

      for (const fixture of [fixtures.a, fixtures.b]) {
        expect(await statusOf(() => route.call(fixture))).toBe(403);
        expect(await displayName(fixture.staffId)).toBe(fixtureName);
      }
    },
  );

  it.each(sessionRoutes.map((route) => [route.name, route] as const))(
    "%s: a 403 too, with no restaurant in the URL to refuse",
    async (_name, route) => {
      session.identity = devPlatformAdmin.key;
      const restaurantBefore = await restaurantRow(fixtures.a.restaurantId);
      const addedBefore = (await addedStaff()).length;
      const categoriesBefore = (await harnessCategories(fixtures.a.restaurantId)).length;

      expect(await statusOf(() => route.call())).toBe(403);

      expect(await restaurantRow(fixtures.a.restaurantId)).toEqual(restaurantBefore);
      expect(await addedStaff()).toHaveLength(addedBefore);
      expect(await harnessCategories(fixtures.a.restaurantId)).toHaveLength(categoriesBefore);
    },
  );
});

describe("a platform admin inside restaurant A", () => {
  const writes = routes.filter((route) => !route.name.startsWith("GET "));

  const inside = async () => {
    session.identity = devPlatformAdmin.key;
    expect(await statusOf(() => enterRoute.call(fixtures.a.restaurantId))).toBeLessThan(400);
  };

  const shadowOfA = async () => {
    const [row] = await owner.db
      .select({ id: staff.id })
      .from(staff)
      .where(
        and(eq(staff.restaurantId, fixtures.a.restaurantId), eq(staff.kind, "platform_admin")),
      );
    return row.id;
  };

  const auditEntries = (restaurantId: string) =>
    owner.db.select().from(auditLog).where(eq(auditLog.restaurantId, restaurantId));

  /** What `call` adds to restaurant A's audit log. */
  const auditedBy = async (call: () => Promise<unknown>) => {
    const known = new Set(
      (await auditEntries(fixtures.a.restaurantId)).map(({ id }) => id),
    );
    await call();
    return (await auditEntries(fixtures.a.restaurantId)).filter(
      ({ id, actorId }) =>
        !known.has(id) && actorId === devPlatformAdmin.platformAdminId,
    );
  };

  beforeEach(inside);
  afterEach(leave);

  it.each(routes.map((route) => [route.name, route] as const))(
    "%s: reaches restaurant A's resource as an owner",
    async (_name, route) => {
      expect(await statusOf(() => route.call(fixtures.a))).toBeLessThan(400);
    },
  );

  it.each(routes.map((route) => [route.name, route] as const))(
    "%s: gets a 404 or 403 on restaurant B's resource and changes nothing",
    async (_name, route) => {
      expect([403, 404]).toContain(await statusOf(() => route.call(fixtures.b)));

      expect(await displayName(fixtures.b.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.b.staffId)).toEqual(untouched);
    },
  );

  it.each(writes.map((route) => [route.name, route] as const))(
    "%s: is audited as the platform admin, by platform_admins.id",
    async (_name, route) => {
      const entries = await auditedBy(() => route.call(fixtures.a));

      expect(entries).not.toEqual([]);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          actorType: "platform_admin",
          actorId: devPlatformAdmin.platformAdminId,
        });
      }
    },
  );

  it.each(sessionRoutes.map((route) => [route.name, route] as const))(
    "%s: is audited as the platform admin too",
    async (_name, route) => {
      const entries = await auditedBy(() => route.call());

      expect(entries).not.toEqual([]);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          actorType: "platform_admin",
          actorId: devPlatformAdmin.platformAdminId,
        });
      }
    },
  );

  it("no write is audited under the shadow row: S-29", async () => {
    const shadowId = await shadowOfA();
    for (const route of writes) {
      await route.call(fixtures.a);
      // One route archives what the next one edits.
      await resetMenuFixtures();
    }
    for (const route of sessionRoutes) await route.call();

    const actors = (await auditEntries(fixtures.a.restaurantId)).map(
      ({ actorId }) => actorId,
    );
    expect(actors).not.toContain(shadowId);
  });

  it("no audit entry holds the Wi-Fi password an admin saved", async () => {
    const wifiPassword = `secret-${crypto.randomUUID()}`;
    const [settings] = sessionRoutes;

    const entries = await auditedBy(() => settings.call({ wifiPassword }));

    expect(JSON.stringify(entries)).not.toContain(wifiPassword);
  });

  it("settings go to the entered restaurant, whatever id the request names", async () => {
    const theirs = await restaurantRow(fixtures.b.restaurantId);
    const [settings] = sessionRoutes;

    await settings.call(
      { restaurantId: fixtures.b.restaurantId, restaurant_id: fixtures.b.restaurantId },
      {
        headers: { "x-restaurant-id": fixtures.b.restaurantId },
        path: `/api/restaurant?restaurantId=${fixtures.b.restaurantId}`,
      },
    );

    expect(await restaurantRow(fixtures.b.restaurantId)).toEqual(theirs);
  });

  it("after leaving, the same calls are refused again", async () => {
    await leave();

    for (const route of routes) {
      expect(await statusOf(() => route.call(fixtures.a))).toBe(403);
    }
  });

  describe("the shadow row", () => {
    const eachOwner = routes
      .filter((route) => route.name.includes("[staffId]"))
      .flatMap((route) =>
        [aOwner.key, devPlatformAdmin.key].map(
          (key) => [route.name, key, route] as const,
        ),
      );

    it.each(eachOwner)(
      "%s: to %s it doesn't exist, so it's a 404 and changes nothing",
      async (_name, key, route) => {
        const staffId = await shadowOfA();
        session.identity = key;

        expect(await statusOf(() => route.call({ ...fixtures.a, staffId }))).toBe(404);

        const [row] = await owner.db.select().from(staff).where(eq(staff.id, staffId));
        expect(row).toMatchObject({
          displayName: "Platform admin",
          role: "owner",
          active: true,
        });
      },
    );
  });
});

describe("harness coverage", () => {
  const appDirectory = join(process.cwd(), "src", "app");
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

  const appFiles = readdirSync(appDirectory, {
    recursive: true,
    encoding: "utf8",
  }).filter((file) => !/\.test\.tsx?$/.test(file));

  const routePath = (file: string) =>
    `/${file.split(sep).slice(0, -1).join("/")}`;

  it("every route handler in src/app is in the harness", async () => {
    const found: string[] = [];
    for (const file of appFiles.filter((file) => /(^|\/)route\.tsx?$/.test(file))) {
      const handlers: Record<string, unknown> = await import(
        /* @vite-ignore */ join(appDirectory, file)
      );
      for (const method of methods) {
        if (handlers[method]) found.push(`${method} ${routePath(file)}`);
      }
    }

    const covered = [
      ...routes.map((route) => route.name),
      ...adminRoutes.map((route) => route.name),
      ...sessionRoutes.map((route) => route.name),
      ...publicRoutes.map((route) => route.name),
      ...outsideTheHarness,
    ];
    expect(found.sort()).toEqual(covered.sort());
  });

  it("no page takes an id and no Server Function exists that the harness doesn't know about", () => {
    // None yet. The first one needs a way in: add a TenantRoute that calls it.
    const pagesWithParams = appFiles.filter(
      (file) => /(^|\/)page\.tsx?$/.test(file) && file.includes("["),
    );
    const serverFunctions = appFiles.filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        readFileSync(join(appDirectory, file), "utf8").includes("use server"),
    );
    expect([...pagesWithParams, ...serverFunctions]).toEqual([]);
  });

  it("only the platform-admin seam calls the privileged functions", () => {
    const sourceDirectory = join(process.cwd(), "src");
    const callers = readdirSync(sourceDirectory, {
      recursive: true,
      encoding: "utf8",
    }).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        /platform_(create|list|enter|leave)_/.test(
          readFileSync(join(sourceDirectory, file), "utf8"),
        ),
    );
    expect(callers).toEqual([join("lib", "tenant", "platform-admin.ts")]);
  });

  it("only the public seam calls the token lookups", () => {
    const sourceDirectory = join(process.cwd(), "src");
    const callers = readdirSync(sourceDirectory, {
      recursive: true,
      encoding: "utf8",
    }).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        /restaurant_id_by_/.test(readFileSync(join(sourceDirectory, file), "utf8")),
    );
    expect(callers).toEqual([join("lib", "tenant", "public.ts")]);
  });

  it("only the admin seam opens the admin login", () => {
    const sourceDirectory = join(process.cwd(), "src");
    const openers = readdirSync(sourceDirectory, {
      recursive: true,
      encoding: "utf8",
    }).filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        /getAdminDb\(|authDatabase\(|DATABASE_URL_ADMIN/.test(
          readFileSync(join(sourceDirectory, file), "utf8"),
        ),
    );
    expect(openers.sort()).toEqual(
      [
        join("db", "admin.ts"),
        join("lib", "auth", "code-limit.ts"),
        join("lib", "auth", "database.ts"),
        join("lib", "auth", "identity.ts"),
        join("lib", "auth", "index.ts"),
        join("lib", "env.ts"),
        join("lib", "tenant", "admin-entry.ts"),
        join("lib", "tenant", "platform-admin.ts"),
      ].sort(),
    );
  });

  it("identities really are in the restaurants the tests assume", () => {
    expect(findDevIdentity("a-owner")?.restaurantId).toBe(fixtures.a.restaurantId);
    expect(findDevIdentity("b-owner")?.restaurantId).toBe(fixtures.b.restaurantId);
    expect(fixtures.a.restaurantId).not.toBe(fixtures.b.restaurantId);
  });
});
