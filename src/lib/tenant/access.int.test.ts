import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
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
  bookings,
  bookingSettings,
  categories,
  diningTables,
  menuItems,
  restaurants,
  servicePeriods,
  staff,
  staffAuthUser,
} from "@/db/schema";
import { addDays, localToday } from "@/lib/booking-engine";
import { signIn } from "../../../test/integration/auth";
import {
  aBooking,
  bookableRestaurant,
  bookingsOf,
} from "../../../test/integration/bookings";
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
  // Only a real request has a connection to wait for.
  connection: async () => {},
}));

// The day view's forms ask the App Router for a router the harness doesn't mount.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
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
  tableId: string;
  periodId: string;
  restaurantId: string;
};

type TenantRoute = {
  name: string;
  ownerOnly: boolean;
  call: (target: Target) => Promise<Response>;
};

const harnessItem = "Harness item";
const harnessCategory = "Harness category";
const harnessTablePrefix = "Harness table ";
/** Tables the archive route is aimed at: not the ones a new-table test counts. */
const plantedPrefix = "Harness planted ";
/** Not under the prefix above, which counts the tables the add route made. */
const regeneratedLabel = "Harness regenerated";
/** A table's QR token, one for each restaurant's table the harness plants. */
const fixtureTableToken = (restaurant: "a" | "b") =>
  `Harness${restaurant.toUpperCase()}`.padEnd(22, "0");

/** A guest's manage token: one booking of each restaurant's, planted far ahead. */
const fixtureManageToken = (restaurant: "a" | "b") =>
  `HarnessManage${restaurant.toUpperCase()}`.padEnd(22, "0");

const regeneratedToken = (restaurant: "a" | "b") =>
  `Regen${restaurant.toUpperCase()}`.padEnd(22, "0");

const staffRoute = () => import("@/app/api/staff/[staffId]/route");
const staffParams = ({ staffId }: Target) => ({
  params: Promise.resolve({ staffId }),
});
const tableParams = (tableId: string) => ({ params: Promise.resolve({ tableId }) });
/** The regenerate fixture of the restaurant whose fixture table this is; any other id as it is. */
const regenerationTarget = (tableId: string) =>
  tableId === fixtures.a.tableId
    ? fixtures.a.regeneratedTableId
    : tableId === fixtures.b.tableId
      ? fixtures.b.regeneratedTableId
      : tableId;
/** The tables the archive route was aimed at, by restaurant. */
const planted: { id: string; restaurantId: string }[] = [];
const plantTable = async (restaurantId: string) => {
  const id = crypto.randomUUID();
  await owner.db.insert(diningTables).values({
    id,
    restaurantId,
    label: `${plantedPrefix}${id}`,
    capacity: 2,
    qrToken: id.replaceAll("-", "").padEnd(22, "0"),
  });
  planted.push({ id, restaurantId });
  return id;
};
/** Service periods the delete route is aimed at: not the fixture period, which the edit route needs. */
const plantedPeriodPrefix = "Harness planted period ";
const plantedPeriods: { id: string; restaurantId: string }[] = [];
/** Periods are one minute wide and two apart, so any number of them never overlap. */
let periodSlot = 0;
const slotTimes = (slot: number) => {
  const clock = (minutes: number) =>
    `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return { opensAt: clock(slot * 2), closesAt: clock(slot * 2 + 1) };
};
const plantPeriod = async (restaurantId: string) => {
  const id = crypto.randomUUID();
  const { opensAt, closesAt } = slotTimes(periodSlot++);
  await owner.db.insert(servicePeriods).values({
    id,
    restaurantId,
    name: `${plantedPeriodPrefix}${id.slice(0, 8)}`,
    weekday: 2,
    opensAt,
    lastBookingAt: opensAt,
    closesAt,
  });
  plantedPeriods.push({ id, restaurantId });
  return id;
};
const periodParams = (periodId: string) => ({ params: Promise.resolve({ periodId }) });
/**
 * Bookings the day view actions are aimed at. Each call plants one of its own, in
 * the target's restaurant and on its fixture table: an action can be taken once,
 * so it can't be run again on the same booking. Slots are three hours apart from
 * 2031, so no two holds overlap on the table, and nothing is near a real day list.
 */
const plantedBookingPrefix = "Harness booking ";
type BookingStatus = typeof bookings.$inferSelect.status;
const plantedBookings: { id: string; restaurantId: string; status: BookingStatus }[] = [];
let bookingSlot = 0;
const plantBooking = async (target: Target, status: BookingStatus) => {
  const id = crypto.randomUUID();
  const starts = Date.UTC(2031, 0, 1) + bookingSlot++ * 3 * 3_600_000;
  await owner.db.insert(bookings).values({
    ...aBooking(
      target.restaurantId,
      target.tableId,
      new Date(starts).toISOString(),
      new Date(starts + 2 * 3_600_000).toISOString(),
    ),
    id,
    guestName: `${plantedBookingPrefix}${id}`,
    status,
  });
  plantedBookings.push({ id, restaurantId: target.restaurantId, status });
  return id;
};
const bookingParams = (bookingId: string) => ({ params: Promise.resolve({ bookingId }) });
const bookingRoutes = {
  seat: () => import("@/app/api/bookings/[bookingId]/seat/route"),
  finish: () => import("@/app/api/bookings/[bookingId]/finish/route"),
  "no-show": () => import("@/app/api/bookings/[bookingId]/no-show/route"),
  cancel: () => import("@/app/api/bookings/[bookingId]/cancel/route"),
};
/** An action on a booking planted for it: the one status it can act on. */
const bookingAction = (
  action: keyof typeof bookingRoutes,
  from: BookingStatus,
): TenantRoute => ({
  name: `POST /api/bookings/[bookingId]/${action}`,
  ownerOnly: false,
  call: async (target) => {
    // A made-up id, like the malformed ones tried above, is aimed at as it is.
    const bookingId = [fixtures.a.tableId, fixtures.b.tableId].includes(target.tableId)
      ? await plantBooking(target, from)
      : target.tableId;
    return postBookingAction(action, bookingId);
  },
});
const postBookingAction = async (action: keyof typeof bookingRoutes, bookingId: string, query = "") =>
  (await bookingRoutes[action]()).POST(
    request(`/api/bookings/${bookingId}/${action}${query}`, { method: "POST" }),
    bookingParams(bookingId),
  );
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
    // Idempotent, so it can run against the fixture table as often as asked.
    name: "POST /api/tables/[tableId]",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/tables/[tableId]/route")).POST(
        request(`/api/tables/${target.tableId}`, {
          method: "POST",
          body: form({ label: fixtureName, capacity: "2", bookable: "true" }),
        }),
        tableParams(target.tableId),
      ),
  },
  {
    name: "POST /api/tables/[tableId]/move",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/tables/[tableId]/move/route")).POST(
        request(`/api/tables/${target.tableId}/move`, {
          method: "POST",
          body: form({ direction: "down" }),
        }),
        tableParams(target.tableId),
      ),
  },
  {
    // Archiving can't be undone, so it takes a table planted in the target's
    // restaurant for the purpose: the fixture table stays live for the rest.
    name: "POST /api/tables/[tableId]/archive",
    ownerOnly: true,
    call: async (target) => {
      // A made-up id, like the malformed ones tried below, is aimed at as it is.
      const tableId = [fixtures.a.tableId, fixtures.b.tableId].includes(target.tableId)
        ? await plantTable(target.restaurantId)
        : target.tableId;
      return (await import("@/app/api/tables/[tableId]/archive/route")).POST(
        request(`/api/tables/${tableId}/archive`, { method: "POST" }),
        tableParams(tableId),
      );
    },
  },
  {
    name: "POST /api/tables/[tableId]/regenerate",
    ownerOnly: true,
    // Regenerating changes the token, so it takes tables of its own: the fixture
    // table's id maps to its restaurant's regenerate table, any other id is used as it is.
    call: async (target) => {
      const tableId = regenerationTarget(target.tableId);
      return (await import("@/app/api/tables/[tableId]/regenerate/route")).POST(
        request(`/api/tables/${tableId}/regenerate`, { method: "POST" }),
        tableParams(tableId),
      );
    },
  },
  {
    // Idempotent: it saves the fixture period's own values.
    name: "POST /api/bookings/periods/[periodId]",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/bookings/periods/[periodId]/route")).POST(
        request(`/api/bookings/periods/${target.periodId}`, {
          method: "POST",
          body: form({
            name: fixtureName,
            opensAt: "12:00",
            lastBookingAt: "12:30",
            closesAt: "13:00",
          }),
        }),
        periodParams(target.periodId),
      ),
  },
  {
    // Deleting can't be undone, so it takes a period planted in the target's
    // restaurant for the purpose: the fixture period stays for the rest.
    name: "POST /api/bookings/periods/[periodId]/delete",
    ownerOnly: true,
    call: async (target) => {
      const periodId = [fixtures.a.periodId, fixtures.b.periodId].includes(target.periodId)
        ? await plantPeriod(target.restaurantId)
        : target.periodId;
      return (await import("@/app/api/bookings/periods/[periodId]/delete/route")).POST(
        request(`/api/bookings/periods/${periodId}/delete`, { method: "POST" }),
        periodParams(periodId),
      );
    },
  },
  bookingAction("seat", "confirmed"),
  bookingAction("finish", "seated"),
  bookingAction("no-show", "confirmed"),
  bookingAction("cancel", "confirmed"),
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
const addedPeriodPrefix = "Harness added period ";

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
  {
    // Labels are unique, so each call is a new table.
    name: "POST /api/tables",
    call: async (fields, init) =>
      (await import("@/app/api/tables/route")).POST(
        request(init?.path ?? "/api/tables", {
          method: "POST",
          headers: init?.headers,
          body: form({
            label: `${harnessTablePrefix}${crypto.randomUUID()}`,
            capacity: "4",
            ...fields,
          }),
        }),
      ),
  },
  {
    name: "POST /api/bookings/settings",
    call: async (fields, init) =>
      (await import("@/app/api/bookings/settings/route")).POST(
        request(init?.path ?? "/api/bookings/settings", {
          method: "POST",
          headers: init?.headers,
          // spec 00's defaults: other test files read them.
          body: form({
            slotIntervalMinutes: "15",
            sittingMinutes: "90",
            largePartySize: "5",
            largePartySittingMinutes: "120",
            bufferMinutes: "15",
            minLeadMinutes: "60",
            maxDaysAhead: "30",
            maxOnlinePartySize: "8",
            guestCancelCutoffMinutes: "120",
            maxActiveBookingsPerPhone: "2",
            ...fields,
          }),
        }),
      ),
  },
  {
    // Switching off by default: it always works, where switching on has a gate.
    name: "POST /api/bookings/settings/enabled",
    call: async (fields, init) =>
      (await import("@/app/api/bookings/settings/enabled/route")).POST(
        request(init?.path ?? "/api/bookings/settings/enabled", {
          method: "POST",
          headers: init?.headers,
          body: form({ enabled: "false", ...fields }),
        }),
      ),
  },
  {
    // Each call adds a period of its own, in a slot no other has.
    name: "POST /api/bookings/periods",
    call: async (fields, init) => {
      const { opensAt, closesAt } = slotTimes(periodSlot++);
      return (await import("@/app/api/bookings/periods/route")).POST(
        request(init?.path ?? "/api/bookings/periods", {
          method: "POST",
          headers: init?.headers,
          body: form({
            name: `${addedPeriodPrefix}${crypto.randomUUID().slice(0, 8)}`,
            weekday: "4",
            opensAt,
            lastBookingAt: opensAt,
            closesAt,
            ...fields,
          }),
        }),
      );
    },
  },
];

/**
 * Routes with no session at all, where the token is the only tenant input (spec
 * 01). There's no identity to refuse: what's left to prove is that nothing else
 * in the request can choose a tenant, in "public routes" below.
 */
type PublicRoute = {
  name: string;
  /** The token of restaurant A's or B's seeded page. */
  tokenOf: (restaurant: "a" | "b") => string;
  call: (
    token: string,
    init?: { query?: string; headers?: Record<string, string> },
  ) => Promise<Response>;
};

const publicRoutes: PublicRoute[] = [
  {
    name: "GET /m/[menuToken]",
    tokenOf: (restaurant) => `dev-menu-restaurant-${restaurant}`,
    call: async (menuToken, init) =>
      (await import("@/app/m/[menuToken]/route")).GET(
        request(`/m/${menuToken}${init?.query ?? ""}`, { headers: init?.headers }),
        { params: Promise.resolve({ menuToken }) },
      ),
  },
  {
    name: "GET /t/[qrToken]",
    tokenOf: fixtureTableToken,
    call: async (qrToken, init) =>
      (await import("@/app/t/[qrToken]/route")).GET(
        request(`/t/${qrToken}${init?.query ?? ""}`, { headers: init?.headers }),
        { params: Promise.resolve({ qrToken }) },
      ),
  },
  {
    name: "GET /b/[manageToken]",
    tokenOf: fixtureManageToken,
    call: async (manageToken, init) =>
      (await import("@/app/b/[manageToken]/route")).GET(
        request(`/b/${manageToken}${init?.query ?? ""}`, { headers: init?.headers }),
        { params: Promise.resolve({ manageToken }) },
      ),
  },
  {
    // A page, not a handler, so it goes through what the page renders.
    name: "PAGE /r/[slug]/book",
    tokenOf: (restaurant) => `restaurant-${restaurant}`,
    call: async (slug, init) => {
      const { default: Page } = await import("@/app/r/[slug]/book/page");
      const searchParams = Object.fromEntries(new URLSearchParams(init?.query));
      return new Response(
        renderToStaticMarkup(
          await Page({
            params: Promise.resolve({ slug }),
            searchParams: Promise.resolve(searchParams),
          }),
        ),
      );
    },
  },
];

/** The one public write. It takes its slug like the pages, and is tested below them. */
const guestConfirm = "POST /api/r/[slug]/book";

/** The other: a guest's cancel, by their manage token and nothing else. */
const guestCancel = "POST /b/[manageToken]";

const postCancel = async (
  manageToken: string,
  init?: { query?: string; headers?: Record<string, string>; body?: FormData },
) =>
  (await import("@/app/b/[manageToken]/route")).POST(
    request(`/b/${manageToken}${init?.query ?? ""}`, {
      method: "POST",
      headers: init?.headers,
      body: init?.body,
    }),
    { params: Promise.resolve({ manageToken }) },
  );

/** What a guest's browser posts, for a time that's free tomorrow at any hour of today. */
const guestForm = (extra: Record<string, string> = {}) => {
  const body = new FormData();
  const fields = {
    party: "2",
    date: addDays(localToday(new Date(), "Africa/Harare"), 1),
    time: "19:00",
    name: "Harness guest",
    phone: "0771234567",
    consent: "on",
    ...extra,
  };
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};

const postBooking = async (
  slug: string,
  init?: { query?: string; headers?: Record<string, string>; body?: FormData },
) =>
  (await import("@/app/api/r/[slug]/book/route")).POST(
    request(`/api/r/${slug}/book${init?.query ?? ""}`, {
      method: "POST",
      headers: init?.headers,
      body: init?.body ?? guestForm(),
    }),
    { params: Promise.resolve({ slug }) },
  );

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
    tableId: crypto.randomUUID(),
    regeneratedTableId: crypto.randomUUID(),
    periodId: crypto.randomUUID(),
    restaurantId: aOwner.restaurantId,
  },
  b: {
    staffId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    tableId: crypto.randomUUID(),
    regeneratedTableId: crypto.randomUUID(),
    periodId: crypto.randomUUID(),
    restaurantId: bOwner.restaurantId,
  },
};
const fixtureName = "Harness fixture";
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
    Object.values(fixtures).map(({ categoryId, restaurantId }) => ({
      id: categoryId,
      restaurantId,
      name: fixtureName,
    })),
  );
  await owner.db.insert(diningTables).values(
    (["a", "b"] as const).map((key) => ({
      id: fixtures[key].tableId,
      restaurantId: fixtures[key].restaurantId,
      label: fixtureName,
      capacity: 2,
      qrToken: fixtureTableToken(key),
    })),
  );
  // The edit route is aimed at a period of each restaurant's. Sunday, so none of the
  // others the harness adds (Tuesday, Thursday) can overlap it.
  await owner.db.insert(servicePeriods).values(
    (["a", "b"] as const).map((key) => ({
      id: fixtures[key].periodId,
      restaurantId: fixtures[key].restaurantId,
      name: fixtureName,
      weekday: 0,
      opensAt: "12:00",
      lastBookingAt: "12:30",
      closesAt: "13:00",
    })),
  );
  // The regenerate route changes its table's token, so it gets tables of its own.
  await owner.db.insert(diningTables).values(
    (["a", "b"] as const).map((key) => ({
      id: fixtures[key].regeneratedTableId,
      restaurantId: fixtures[key].restaurantId,
      label: regeneratedLabel,
      capacity: 2,
      qrToken: regeneratedToken(key),
    })),
  );
  // The manage page is aimed at a booking of each restaurant's, far ahead of the
  // day list's today and clear of any cutoff.
  await owner.db.insert(bookings).values(
    (["a", "b"] as const).map((key) => ({
      ...aBooking(
        fixtures[key].restaurantId,
        fixtures[key].tableId,
        "2031-03-04T10:00:00Z",
        "2031-03-04T11:00:00Z",
      ),
      manageToken: fixtureManageToken(key),
    })),
  );
});

afterEach(async () => {
  await owner.db
    .update(staff)
    .set({ displayName: fixtureName, role: "staff", active: true })
    .where(eq(staff.id, fixtures.a.staffId));
});

afterAll(async () => {
  await owner.db
    .delete(bookings)
    .where(inArray(bookings.manageToken, [fixtureManageToken("a"), fixtureManageToken("b")]));
  for (const { staffId } of Object.values(fixtures)) {
    await owner.db.delete(staff).where(eq(staff.id, staffId));
  }
  await owner.db.delete(menuItems).where(eq(menuItems.name, harnessItem));
  await owner.db.delete(bookings).where(like(bookings.guestName, `${plantedBookingPrefix}%`));
  await owner.db
    .delete(diningTables)
    .where(
      or(
        eq(diningTables.label, fixtureName),
        eq(diningTables.label, regeneratedLabel),
        like(diningTables.label, `${harnessTablePrefix}%`),
        like(diningTables.label, `${plantedPrefix}%`),
      ),
    );
  await owner.db
    .delete(servicePeriods)
    .where(
      or(
        eq(servicePeriods.name, fixtureName),
        like(servicePeriods.name, `${plantedPeriodPrefix}%`),
        like(servicePeriods.name, `${addedPeriodPrefix}%`),
      ),
    );
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

/** What the table routes would change in a restaurant, apart from the table they're aimed at. */
const tableStanding = async (tableId: string) => {
  const [row] = await owner.db
    .select({
      label: diningTables.label,
      capacity: diningTables.capacity,
      bookable: diningTables.bookable,
      sortOrder: diningTables.sortOrder,
      archivedAt: diningTables.archivedAt,
    })
    .from(diningTables)
    .where(eq(diningTables.id, tableId));
  return row;
};
/** Whether the tables planted since `mark` in a restaurant are all still live. */
const unarchived = async (restaurantId: string, mark: number) =>
  (
    await Promise.all(
      planted
        .slice(mark)
        .filter((table) => table.restaurantId === restaurantId)
        .map(({ id }) => tableStanding(id)),
    )
  ).every((row) => row.archivedAt === null);

/** What the booking routes would change in a restaurant. */
const periodStanding = async (periodId: string) => {
  const [row] = await owner.db
    .select()
    .from(servicePeriods)
    .where(eq(servicePeriods.id, periodId));
  return row;
};
const bookingSettingsOf = async (restaurantId: string) => {
  const [row] = await owner.db
    .select()
    .from(bookingSettings)
    .where(eq(bookingSettings.restaurantId, restaurantId));
  return row;
};
const periodsNamed = (restaurantId: string, prefix: string) =>
  owner.db
    .select({ id: servicePeriods.id })
    .from(servicePeriods)
    .where(
      and(eq(servicePeriods.restaurantId, restaurantId), like(servicePeriods.name, `${prefix}%`)),
    );
/** Whether the periods planted since `mark` in a restaurant are all still there. */
const unremoved = async (restaurantId: string, mark: number) =>
  (
    await Promise.all(
      plantedPeriods
        .slice(mark)
        .filter((period) => period.restaurantId === restaurantId)
        .map(({ id }) => periodStanding(id)),
    )
  ).every((row) => row !== undefined);

/** Whether the bookings planted since `mark` in a restaurant are all as they were planted. */
const bookingsAsPlanted = async (restaurantId: string, mark: number) => {
  const rows = await Promise.all(
    plantedBookings
      .slice(mark)
      .filter((booking) => booking.restaurantId === restaurantId)
      .map(async ({ id, status }) => {
        const [row] = await owner.db.select().from(bookings).where(eq(bookings.id, id));
        return row.status === status && row.cancelledBy === null;
      }),
  );
  return rows.every(Boolean);
};

const harnessTables = (restaurantId: string) =>
  owner.db
    .select({ id: diningTables.id })
    .from(diningTables)
    .where(
      and(
        eq(diningTables.restaurantId, restaurantId),
        like(diningTables.label, `${harnessTablePrefix}%`),
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
      const bTable = await tableStanding(fixtures.b.tableId);
      const bPeriod = await periodStanding(fixtures.b.periodId);
      const mark = planted.length;
      const periodMark = plantedPeriods.length;
      const bookingMark = plantedBookings.length;

      const status = await statusOf(() => route.call(fixtures.b));

      expect([403, 404]).toContain(status);
      expect(await displayName(fixtures.b.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.b.staffId)).toEqual(untouched);
      expect(await harnessItems(fixtures.b.restaurantId)).toEqual([]);
      expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(itemsInA);
      expect(await tableStanding(fixtures.b.tableId)).toEqual(bTable);
      expect(await unarchived(fixtures.b.restaurantId, mark)).toBe(true);
      expect(await periodStanding(fixtures.b.periodId)).toEqual(bPeriod);
      expect(await unremoved(fixtures.b.restaurantId, periodMark)).toBe(true);
      expect(await bookingsAsPlanted(fixtures.b.restaurantId, bookingMark)).toBe(true);
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

describe("regenerating a table's token", () => {
  const [regenerate] = routes.filter((route) => route.name.endsWith("/regenerate"));
  const tokenOf = async (tableId: string) => {
    const [row] = await owner.db
      .select({ qrToken: diningTables.qrToken, rotatedAt: diningTables.tokenRotatedAt })
      .from(diningTables)
      .where(eq(diningTables.id, tableId));
    return row;
  };

  it("leaves another restaurant's token alone, whoever asks", async () => {
    const theirs = await tokenOf(fixtures.b.regeneratedTableId);
    for (const identity of [aOwner, aStaff]) {
      session.identity = identity.key;
      await statusOf(() => regenerate.call(fixtures.b));
    }
    expect(await tokenOf(fixtures.b.regeneratedTableId)).toEqual(theirs);
    expect(theirs.qrToken).toBe(regeneratedToken("b"));
  });

  it("leaves the token alone for a staff context in its own restaurant", async () => {
    session.identity = aStaff.key;
    const before = await tokenOf(fixtures.a.regeneratedTableId);

    expect(await statusOf(() => regenerate.call(fixtures.a))).toBe(403);

    expect(await tokenOf(fixtures.a.regeneratedTableId)).toEqual(before);
  });

  it("an owner's regeneration is audited as that owner, without either token", async () => {
    session.identity = aOwner.key;
    const before = await tokenOf(fixtures.a.regeneratedTableId);
    const known = (
      await owner.db.select().from(auditLog).where(eq(auditLog.entityId, fixtures.a.regeneratedTableId))
    ).length;

    expect(await statusOf(() => regenerate.call(fixtures.a))).toBeLessThan(400);

    const entries = await owner.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, fixtures.a.regeneratedTableId));
    expect(entries).toHaveLength(known + 1);
    expect(entries).toContainEqual(
      expect.objectContaining({ action: "table.regenerate_qr", actorType: "staff" }),
    );
    const after = await tokenOf(fixtures.a.regeneratedTableId);
    expect(after.qrToken).not.toBe(before.qrToken);
    expect(JSON.stringify(entries)).not.toContain(before.qrToken);
    expect(JSON.stringify(entries)).not.toContain(after.qrToken);
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
      const aTable = await tableStanding(fixtures.a.tableId);
      const aPeriod = await periodStanding(fixtures.a.periodId);
      const mark = planted.length;
      const periodMark = plantedPeriods.length;

      expect(await statusOf(() => route.call(fixtures.a))).toBe(403);
      expect(await displayName(fixtures.a.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.a.staffId)).toEqual(untouched);
      expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(items);
      expect(await tableStanding(fixtures.a.tableId)).toEqual(aTable);
      expect(await unarchived(fixtures.a.restaurantId, mark)).toBe(true);
      expect(await periodStanding(fixtures.a.periodId)).toEqual(aPeriod);
      expect(await unremoved(fixtures.a.restaurantId, periodMark)).toBe(true);
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

describe("archiving a table with future bookings", () => {
  const archivePath = (tableId: string) => `/api/tables/${tableId}/archive`;
  const callArchive = async (tableId: string) =>
    (await import("@/app/api/tables/[tableId]/archive/route")).POST(
      request(archivePath(tableId), { method: "POST" }),
      tableParams(tableId),
    );

  const plantedBookings: string[] = [];
  /** A planted table in the restaurant with a future confirmed booking on it. */
  const bookedTable = async (restaurantId: string) => {
    const tableId = await plantTable(restaurantId);
    const row = {
      ...aBooking(
        restaurantId,
        tableId,
        new Date(Date.now() + 24 * 3_600_000).toISOString(),
        new Date(Date.now() + 26 * 3_600_000).toISOString(),
      ),
      guestName: "Harness booked guest",
      guestPhone: "+263779999999",
    };
    await owner.db.insert(bookings).values(row);
    plantedBookings.push(row.manageToken);
    return tableId;
  };
  afterEach(async () => {
    await owner.db.delete(bookings).where(inArray(bookings.manageToken, plantedBookings.splice(0)));
  });

  it("restaurant A's owner gets a 404 on B's booked table: no list, no guest, nothing archived", async () => {
    session.identity = aOwner.key;
    const tableId = await bookedTable(fixtures.b.restaurantId);

    const outcome = await callArchive(tableId).then(
      (response) => ({ status: response.status, body: response.text() }),
      (error: { digest?: string }) => ({ status: Number(/(\d+)$/.exec(String(error.digest))?.[1]), body: Promise.resolve("") }),
    );

    expect(outcome.status).toBe(404);
    const body = await outcome.body;
    expect(body).not.toContain("Harness booked guest");
    expect(body).not.toContain("263779999999");
    expect((await tableStanding(tableId)).archivedAt).toBeNull();
  });

  it("a staff context gets a 403 on its own restaurant's booked table", async () => {
    session.identity = aStaff.key;
    const tableId = await bookedTable(fixtures.a.restaurantId);

    expect(await statusOf(() => callArchive(tableId))).toBe(403);
    expect((await tableStanding(tableId)).archivedAt).toBeNull();
  });

  it("the owner of that restaurant gets the 409 list, and the table stays", async () => {
    session.identity = aOwner.key;
    const tableId = await bookedTable(fixtures.a.restaurantId);

    const response = await callArchive(tableId);

    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("263779999999");
    expect((await tableStanding(tableId)).archivedAt).toBeNull();
  });
});

describe("routes that take no id", () => {
  it.each(sessionRoutes.map((route) => [route.name, route] as const))(
    "%s: a staff context gets a 403 and changes nothing",
    async (_name, route) => {
      session.identity = aStaff.key;
      const before = await restaurantRow(aStaff.restaurantId);
      const added = (await addedStaff()).length;
      const newCategories = (await harnessCategories(aStaff.restaurantId)).length;
      const newTables = (await harnessTables(aStaff.restaurantId)).length;

      expect(
        await statusOf(() => route.call({ contactPhone: "+263771234567" })),
      ).toBe(403);

      expect(await restaurantRow(aStaff.restaurantId)).toEqual(before);
      expect(await addedStaff()).toHaveLength(added);
      expect(await harnessCategories(aStaff.restaurantId)).toHaveLength(newCategories);
      expect(await harnessTables(aStaff.restaurantId)).toHaveLength(newTables);
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

describe("the tables route", () => {
  const addTable = sessionRoutes[3];

  it("a new table joins the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const before = (await harnessTables(fixtures.a.restaurantId)).length;
    const id = fixtures.b.restaurantId;

    const response = await addTable.call(
      { restaurantId: id, restaurant_id: id },
      {
        headers: { "x-restaurant-id": id },
        path: `/api/tables?restaurantId=${id}&restaurant_id=${id}`,
      },
    );

    expect(response.status).toBeLessThan(400);
    expect(await harnessTables(fixtures.b.restaurantId)).toEqual([]);
    expect(await harnessTables(fixtures.a.restaurantId)).toHaveLength(before + 1);
  });

  it("a new table gets a token of its own, 22 characters of base62", async () => {
    session.identity = aOwner.key;
    const label = `${harnessTablePrefix}${crypto.randomUUID()}`;

    await addTable.call({ label });

    const [table] = await owner.db
      .select({ qrToken: diningTables.qrToken })
      .from(diningTables)
      .where(eq(diningTables.label, label));
    expect(table.qrToken).toMatch(/^[0-9A-Za-z]{22}$/);
  });

  it("an edit with restaurant B's id in the request still can't reach B's table", async () => {
    session.identity = aOwner.key;
    const id = fixtures.b.restaurantId;
    const before = await tableStanding(fixtures.b.tableId);

    const response = await statusOf(async () =>
      (await import("@/app/api/tables/[tableId]/route")).POST(
        request(`/api/tables/${fixtures.b.tableId}?restaurantId=${id}`, {
          method: "POST",
          headers: { "x-restaurant-id": id },
          body: form({ label: "Hijacked", capacity: "9", bookable: "false", restaurantId: id }),
        }),
        tableParams(fixtures.b.tableId),
      ),
    );

    expect(response).toBe(404);
    expect(await tableStanding(fixtures.b.tableId)).toEqual(before);
  });

  it("a label a live table has is a 409 and adds nothing", async () => {
    session.identity = aOwner.key;
    const label = `${harnessTablePrefix}${crypto.randomUUID()}`;
    await addTable.call({ label });
    const before = (await harnessTables(fixtures.a.restaurantId)).length;

    const response = await addTable.call({ label });

    expect(response.status).toBe(409);
    expect(await harnessTables(fixtures.a.restaurantId)).toHaveLength(before);
  });
});

describe("the booking routes", () => {
  const [saveRules, enable, addPeriod] = sessionRoutes.slice(4);
  const smuggledB = () => {
    const id = fixtures.b.restaurantId;
    return {
      fields: { restaurantId: id, restaurant_id: id },
      init: (path: string) => ({
        headers: { "x-restaurant-id": id },
        path: `${path}?restaurantId=${id}&restaurant_id=${id}`,
      }),
    };
  };

  it("the rules go to the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const { fields, init } = smuggledB();
    const theirs = await bookingSettingsOf(fixtures.b.restaurantId);

    try {
      const response = await saveRules.call(
        { ...fields, sittingMinutes: "100" },
        init("/api/bookings/settings"),
      );

      expect(response.status).toBeLessThan(400);
      expect(await bookingSettingsOf(fixtures.b.restaurantId)).toEqual(theirs);
      expect(await bookingSettingsOf(fixtures.a.restaurantId)).toMatchObject({ sittingMinutes: 100 });
    } finally {
      await saveRules.call();
    }
  });

  it("a staff context can't change the rules", async () => {
    session.identity = aStaff.key;
    const before = await bookingSettingsOf(fixtures.a.restaurantId);

    expect(await statusOf(() => saveRules.call({ sittingMinutes: "61" }))).toBe(403);

    expect(await bookingSettingsOf(fixtures.a.restaurantId)).toEqual(before);
  });

  it("a staff context can't turn booking on, and the owner is refused while the phone is missing", async () => {
    session.identity = aStaff.key;
    expect(await statusOf(() => enable.call({ enabled: "true" }))).toBe(403);
    expect(await bookingSettingsOf(fixtures.a.restaurantId)).toMatchObject({ enabled: false });

    session.identity = aOwner.key;
    const response = await enable.call({ enabled: "true" });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("contact phone");
    expect(await bookingSettingsOf(fixtures.a.restaurantId)).toMatchObject({ enabled: false });
  });

  it("a new period joins the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const { fields, init } = smuggledB();
    const name = `${addedPeriodPrefix}${crypto.randomUUID().slice(0, 8)}`;

    const response = await addPeriod.call({ ...fields, name }, init("/api/bookings/periods"));

    expect(response.status).toBeLessThan(400);
    expect(await periodsNamed(fixtures.b.restaurantId, name)).toEqual([]);
    expect(await periodsNamed(fixtures.a.restaurantId, name)).toHaveLength(1);
  });

  it("a staff context adds no period", async () => {
    session.identity = aStaff.key;
    const before = (await periodsNamed(fixtures.a.restaurantId, addedPeriodPrefix)).length;

    expect(await statusOf(() => addPeriod.call())).toBe(403);

    expect(await periodsNamed(fixtures.a.restaurantId, addedPeriodPrefix)).toHaveLength(before);
  });

  it("an edit with restaurant B's id in the request still can't reach B's period", async () => {
    session.identity = aOwner.key;
    const id = fixtures.b.restaurantId;
    const before = await periodStanding(fixtures.b.periodId);

    const status = await statusOf(async () =>
      (await import("@/app/api/bookings/periods/[periodId]/route")).POST(
        request(`/api/bookings/periods/${fixtures.b.periodId}?restaurantId=${id}`, {
          method: "POST",
          headers: { "x-restaurant-id": id },
          body: form({
            name: "Hijacked",
            opensAt: "10:00",
            lastBookingAt: "11:00",
            closesAt: "12:00",
            restaurantId: id,
          }),
        }),
        periodParams(fixtures.b.periodId),
      ),
    );

    expect(status).toBe(404);
    expect(await periodStanding(fixtures.b.periodId)).toEqual(before);
  });
});

describe("public routes", () => {
  const eachPublic = publicRoutes.map((route) => [route.name, route] as const);

  it.each(eachPublic)("%s: needs no session", async (_name, route) => {
    session.identity = "";
    expect(await statusOf(() => route.call(route.tokenOf("a")))).toBe(200);
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

      const response = await route.call(route.tokenOf("b"), {
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
        expect(await statusOf(() => route.call({ ...fixtures.a, staffId, categoryId, tableId: staffId, periodId: staffId }))).toBe(404);
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
    for (const route of writes) await route.call(fixtures.a);
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

describe("the guest's confirm", () => {
  it("needs no session", async () => {
    session.identity = "";
    const { slug, restaurantId } = await bookableRestaurant(owner.db);

    expect(await statusOf(() => postBooking(slug))).toBe(201);
    expect(await bookingsOf(owner.db, restaurantId)).toHaveLength(1);
  });

  it("is a 404 for an unknown slug, and for a NUL in one", async () => {
    session.identity = "";
    expect(await statusOf(() => postBooking("no-such-restaurant"))).toBe(404);
    expect(await statusOf(() => postBooking("a\0b"))).toBe(404);
  });

  it("a restaurant id in the query, headers or body can't stand in for the slug", async () => {
    session.identity = aOwner.key;
    const { restaurantId } = await bookableRestaurant(owner.db);

    expect(
      await statusOf(() =>
        postBooking("no-such-restaurant", {
          query: `?restaurantId=${restaurantId}`,
          headers: { "x-restaurant-id": restaurantId },
          body: guestForm({ restaurantId, restaurant_id: restaurantId }),
        }),
      ),
    ).toBe(404);
    expect(await bookingsOf(owner.db, restaurantId)).toEqual([]);
  });

  it("the slug decides the tenant, not the query, the headers, the body or a session", async () => {
    session.identity = aOwner.key;
    const named = await bookableRestaurant(owner.db);
    const other = await bookableRestaurant(owner.db);
    const id = other.restaurantId;

    const response = await postBooking(named.slug, {
      query: `?restaurantId=${id}`,
      headers: { "x-restaurant-id": id },
      body: guestForm({ restaurantId: id, restaurant_id: id, tableId: other.tableIds[0] }),
    });

    expect(response.status).toBe(201);
    expect(await bookingsOf(owner.db, id)).toEqual([]);
    const [booked] = await bookingsOf(owner.db, named.restaurantId);
    expect(booked.tableId).toBe(named.tableIds[0]);
  });
});

describe("the day view's actions", () => {
  const actions = ["seat", "finish", "no-show", "cancel"] as const;
  const from = { seat: "confirmed", finish: "seated", "no-show": "confirmed", cancel: "confirmed" } as const;
  const standingOf = async (id: string) => {
    const [row] = await owner.db.select().from(bookings).where(eq(bookings.id, id));
    return row;
  };
  const to = { seat: "seated", finish: "completed", "no-show": "no_show", cancel: "cancelled" } as const;

  it.each(actions.flatMap((action) => [aOwner, aStaff].map((who) => [action, who.key, who] as const)))(
    "%s: %s, an owner or staff, acts on a booking of their restaurant (S-26)",
    async (action, _key, who) => {
      session.identity = who.key;
      const id = await plantBooking(fixtures.a, from[action]);

      const response = await postBookingAction(action, id);

      expect(response.status).toBeLessThan(400);
      expect((await standingOf(id)).status).toBe(to[action]);
    },
  );

  it.each(actions)("%s: a second tap is a 409 that says what the booking is now, and changes nothing more", async (action) => {
    session.identity = aStaff.key;
    const id = await plantBooking(fixtures.a, from[action]);
    await postBookingAction(action, id);
    const settled = await standingOf(id);

    const response = await postBookingAction(action, id);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already (seated|finished|marked as a no-show|cancelled)/);
    expect(await standingOf(id)).toEqual(settled);
  });

  it.each(actions)("%s: a malformed or unknown id is a 404", async (action) => {
    session.identity = aOwner.key;
    for (const id of ["not-a-uuid", "", "'; drop table bookings; --", "a\0b", crypto.randomUUID()]) {
      expect(await statusOf(() => postBookingAction(action, id))).toBe(404);
    }
  });

  it.each(actions)("%s: a restaurant id in the query, headers or body can't move it to B's booking", async (action) => {
    session.identity = aOwner.key;
    const id = await plantBooking(fixtures.b, from[action]);
    const b = fixtures.b.restaurantId;

    const status = await statusOf(async () =>
      (await bookingRoutes[action]()).POST(
        request(`/api/bookings/${id}/${action}?restaurantId=${b}&restaurant_id=${b}`, {
          method: "POST",
          headers: { "x-restaurant-id": b },
          body: form({ restaurantId: b, restaurant_id: b }),
        }),
        bookingParams(id),
      ),
    );

    expect(status).toBe(404);
    expect((await standingOf(id)).status).toBe(from[action]);
  });

  const auditedFor = (id: string) =>
    owner.db.select().from(auditLog).where(eq(auditLog.entityId, id));

  it("only a cancel by staff is audited, and it names the person who did it", async () => {
    session.identity = aStaff.key;
    const ids = Object.fromEntries(
      await Promise.all(actions.map(async (action) => [action, await plantBooking(fixtures.a, from[action])] as const)),
    );

    for (const action of actions) await postBookingAction(action, ids[action]);

    expect(await auditedFor(ids.seat)).toEqual([]);
    expect(await auditedFor(ids.finish)).toEqual([]);
    expect(await auditedFor(ids["no-show"])).toEqual([]);
    const [entry] = await auditedFor(ids.cancel);
    expect(entry).toMatchObject({
      restaurantId: fixtures.a.restaurantId,
      actorType: "staff",
      action: "booking.cancel",
      entityType: "booking",
    });
    const [{ id: staffId }] = await owner.db
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.restaurantId, fixtures.a.restaurantId), eq(staff.email, emailOf(aStaff.key))));
    expect(entry.actorId).toBe(staffId);
  });

  it("is a 401 with no session, and changes nothing", async () => {
    session.identity = "";
    const id = await plantBooking(fixtures.a, "confirmed");
    for (const action of actions) expect(await statusOf(() => postBookingAction(action, id))).toBe(401);
    expect((await standingOf(id)).status).toBe("confirmed");
  });
});

describe("the guest's confirm: the new refusals stay inside the slug's restaurant", () => {
  it("counts a phone's bookings at the named restaurant only, and refuses nothing for another's", async () => {
    session.identity = "";
    const named = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    const other = await bookableRestaurant(owner.db, { tables: [{ capacity: 2 }, { capacity: 2 }] });
    for (const day of [3, 4]) {
      await owner.db.insert(bookings).values({
        ...aBooking(
          other.restaurantId,
          other.tableIds[0],
          `${addDays(localToday(new Date(), "Africa/Harare"), day)}T10:00:00Z`,
          `${addDays(localToday(new Date(), "Africa/Harare"), day)}T11:00:00Z`,
        ),
        guestPhone: "+263771234567",
      });
    }

    const response = await postBooking(named.slug, {
      query: `?restaurantId=${other.restaurantId}`,
      headers: { "x-restaurant-id": other.restaurantId },
      body: guestForm({ restaurantId: other.restaurantId, phone: "0771234567" }),
    });

    expect(response.status).toBe(201);
    expect(await bookingsOf(owner.db, named.restaurantId)).toHaveLength(1);
    expect(await bookingsOf(owner.db, other.restaurantId)).toHaveLength(2);
  });

  it("answers a large party with the named restaurant's number, never another's", async () => {
    session.identity = "";
    const named = await bookableRestaurant(owner.db);
    const other = await bookableRestaurant(owner.db);
    await owner.db
      .update(restaurants)
      .set({ contactPhone: "+263779999999" })
      .where(eq(restaurants.id, other.restaurantId));

    const response = await postBooking(named.slug, {
      headers: { "x-restaurant-id": other.restaurantId },
      body: guestForm({ party: "9", restaurantId: other.restaurantId }),
    });

    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toContain("9999999");
  });
});

describe("the guest's cancel", () => {
  const MINUTE = 60_000;
  /** A booking far enough ahead to cancel, on a restaurant of its own. */
  async function booked() {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const start = new Date(Date.now() + 300 * MINUTE).toISOString();
    const row = aBooking(restaurantId, tableIds[0], start, new Date(Date.now() + 390 * MINUTE).toISOString());
    await owner.db.insert(bookings).values(row);
    return { restaurantId, token: row.manageToken };
  }
  const statusIn = async (restaurantId: string) =>
    (await bookingsOf(owner.db, restaurantId))[0].status;

  it("needs no session", async () => {
    session.identity = "";
    const { restaurantId, token } = await booked();

    expect(await statusOf(() => postCancel(token))).toBe(200);
    expect(await statusIn(restaurantId)).toBe("cancelled");
  });

  it("is a 404 for an unknown token, and for a NUL in one", async () => {
    session.identity = "";
    expect(await statusOf(() => postCancel("no-such-token"))).toBe(404);
    expect(await statusOf(() => postCancel("a\0b"))).toBe(404);
  });

  it("a restaurant id in the query, headers or body can't stand in for the token", async () => {
    session.identity = aOwner.key;
    const { restaurantId } = await booked();
    const id = fixtures.a.restaurantId;
    const body = new FormData();
    body.set("restaurantId", id);
    body.set("restaurant_id", id);

    expect(
      await statusOf(() =>
        postCancel("no-such-token", {
          query: `?restaurantId=${id}`,
          headers: { "x-restaurant-id": id },
          body,
        }),
      ),
    ).toBe(404);
    expect(await statusIn(restaurantId)).toBe("confirmed");
  });

  it("restaurant B's token cancels B's booking only, whoever is signed in", async () => {
    session.identity = aOwner.key;
    const mine = await booked();
    const theirs = await booked();

    const response = await postCancel(theirs.token, {
      query: `?restaurantId=${mine.restaurantId}`,
      headers: { "x-restaurant-id": mine.restaurantId },
    });

    expect(response.status).toBe(200);
    expect(await statusIn(theirs.restaurantId)).toBe("cancelled");
    expect(await statusIn(mine.restaurantId)).toBe("confirmed");
  });

  it("one restaurant's token is a 404 for a booking of another's: nothing crosses", async () => {
    session.identity = "";
    const aBooked = await owner.db
      .select()
      .from(bookings)
      .where(eq(bookings.manageToken, fixtureManageToken("a")));

    const response = await postCancel(fixtureManageToken("b"));

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Restaurant A");
    const [stillThere] = await owner.db
      .select()
      .from(bookings)
      .where(eq(bookings.manageToken, fixtureManageToken("a")));
    expect(stillThere).toEqual(aBooked[0]);
    // Restore B's, which the cancel above spent.
    await owner.db
      .update(bookings)
      .set({ status: "confirmed", cancelledBy: null, cancelledAt: null })
      .where(eq(bookings.manageToken, fixtureManageToken("b")));
  });
});

describe("the day list", () => {
  const screen = async () => {
    const { BookingsScreen } = await import("@/app/dashboard/bookings/bookings-screen");
    return renderToStaticMarkup(await BookingsScreen({ searchParams: Promise.resolve({}) }));
  };

  const today = () => localToday(new Date(), "Africa/Harare");

  /** A booking today on restaurant B's harness table, gone again however the test ends. */
  async function withBookingInB(run: () => Promise<void>) {
    const name = `Guest of B ${crypto.randomUUID()}`;
    const row = {
      ...aBooking(
        fixtures.b.restaurantId,
        fixtures.b.tableId,
        `${today()}T10:00:00Z`,
        `${today()}T11:00:00Z`,
      ),
      guestName: name,
    };
    await owner.db.insert(bookings).values(row);
    try {
      await run();
    } finally {
      await owner.db.delete(bookings).where(eq(bookings.guestName, name));
    }
    return name;
  }

  it("needs a session", async () => {
    session.identity = "";
    expect(await statusOf(screen)).toBe(401);
  });

  it("shows each restaurant its own bookings, to owners and staff alike", async () => {
    let seenByB = "";
    let seenByBStaff = "";
    let seenByA = "";
    const name = await withBookingInB(async () => {
      session.identity = bOwner.key;
      seenByB = await screen();
      session.identity = bStaff.key;
      seenByBStaff = await screen();
      session.identity = aOwner.key;
      seenByA = await screen();
    });

    expect(seenByB).toContain(name);
    expect(seenByBStaff).toContain(name);
    expect(seenByA).not.toContain(name);
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

  const pagesWithParams = appFiles.filter(
    (file) => /(^|\/)page\.tsx?$/.test(file) && file.includes("["),
  );

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
    found.push(...pagesWithParams.map((file) => `PAGE ${routePath(file)}`));

    const covered = [
      ...routes.map((route) => route.name),
      ...adminRoutes.map((route) => route.name),
      ...sessionRoutes.map((route) => route.name),
      ...publicRoutes.map((route) => route.name),
      guestConfirm,
      guestCancel,
      ...outsideTheHarness,
    ];
    expect(found.sort()).toEqual(covered.sort());
  });

  it("no page takes an id but a public one and no Server Function exists that the harness doesn't know about", () => {
    // The only pages with params so far are public, in `publicRoutes`, and take a
    // slug. The first to take an id needs a way in: add a TenantRoute that calls it.
    const pagesWithIds = pagesWithParams.filter(
      (file) => !publicRoutes.some((route) => route.name === `PAGE ${routePath(file)}`),
    );
    const serverFunctions = appFiles.filter(
      (file) =>
        /\.tsx?$/.test(file) &&
        readFileSync(join(appDirectory, file), "utf8").includes("use server"),
    );
    expect([...pagesWithIds, ...serverFunctions]).toEqual([]);
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
