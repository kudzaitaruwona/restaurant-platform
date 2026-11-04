import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { auditLog, restaurants, staff } from "@/db/schema";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../test/integration/database";
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
 *
 * Handlers run for real against Postgres, as the RLS-bound role. Only the
 * cookie jar is faked: that's the session, and it's the input under test.
 */
const session = vi.hoisted(() => ({ identity: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({ name, value: session.identity }),
  }),
}));

/** What a route acts on: an existing resource in some restaurant. */
type Target = { staffId: string };

type TenantRoute = {
  name: string;
  ownerOnly: boolean;
  call: (target: Target) => Promise<Response>;
};

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
];

/** Holds no tenant data: tested in src/app/api/dev/identity/route.int.test.ts. */
const outsideTheHarness = ["POST /api/dev/identity"];

const [aOwner, aStaff, bOwner, bStaff] = devIdentities;
const restaurantAIdentities = [aOwner, aStaff];

const owner = openOwnerDatabase();

// The harness writes, so it writes to rows of its own and leaves the seed alone.
const fixtures = {
  a: { staffId: crypto.randomUUID(), restaurantId: aOwner.restaurantId },
  b: { staffId: crypto.randomUUID(), restaurantId: bOwner.restaurantId },
};
const fixtureName = "Harness fixture";

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
  await owner.db.insert(staff).values(
    Object.values(fixtures).map(({ staffId, restaurantId }) => ({
      id: staffId,
      restaurantId,
      email: `${staffId}@example.test`,
      displayName: fixtureName,
    })),
  );
});

afterEach(async () => {
  await owner.db
    .update(staff)
    .set({ displayName: fixtureName })
    .where(eq(staff.id, fixtures.a.staffId));
});

afterAll(async () => {
  for (const { staffId } of Object.values(fixtures)) {
    await owner.db.delete(staff).where(eq(staff.id, staffId));
  }
  const created = await harnessRestaurants();
  if (created.length > 0) {
    const ids = created.map(({ id }) => id);
    await owner.db.delete(auditLog).where(inArray(auditLog.restaurantId, ids));
    await owner.db.delete(staff).where(inArray(staff.restaurantId, ids));
    await owner.db.delete(restaurants).where(inArray(restaurants.id, ids));
  }
  await owner.pool.end();
  vi.unstubAllEnvs();
});

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

const each = (identities: typeof restaurantAIdentities) =>
  routes.flatMap((route) =>
    identities.map((identity) => [route.name, identity.key, route, identity] as const),
  );

describe("cross-tenant access", () => {
  it.each(each(restaurantAIdentities))(
    "%s: %s gets a 404 or 403 on restaurant B's resource and changes nothing",
    async (_name, key, route) => {
      session.identity = key;

      const status = await statusOf(() => route.call(fixtures.b));

      expect([403, 404]).toContain(status);
      expect(await displayName(fixtures.b.staffId)).toBe(fixtureName);
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

      expect(await statusOf(() => route.call(fixtures.a))).toBe(403);
      expect(await displayName(fixtures.a.staffId)).toBe(fixtureName);
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
        expect(await statusOf(() => route.call({ staffId }))).toBe(404);
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

describe("platform-admin routes", () => {
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
        /platform_(create|list)_/.test(
          readFileSync(join(sourceDirectory, file), "utf8"),
        ),
    );
    expect(callers).toEqual([join("lib", "tenant", "platform-admin.ts")]);
  });

  it("identities really are in the restaurants the tests assume", () => {
    expect(findDevIdentity("a-owner")?.restaurantId).toBe(fixtures.a.restaurantId);
    expect(findDevIdentity("b-owner")?.restaurantId).toBe(fixtures.b.restaurantId);
    expect(fixtures.a.restaurantId).not.toBe(fixtures.b.restaurantId);
  });
});
