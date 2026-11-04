import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
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
  closures,
  diningTables,
  exchangeRates,
  menuItems,
  restaurants,
  servicePeriods,
  specials,
  staff,
  staffAuthUser,
} from "@/db/schema";
import { addDays, localToday, weekdayOf } from "@/lib/booking-engine";
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

// Photos are stored through the app's storage interface, which is faked here so
// nothing reaches R2. `calls` counts what a route asked it to store or delete.
const storage = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/storage", () => ({
  uploadImage: async (key: string) => {
    storage.calls++;
    return { key, url: `https://cdn.example.test/${key}` };
  },
  deleteImage: async () => {
    storage.calls++;
  },
  getUrl: (key: string) => `https://cdn.example.test/${key}`,
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
  /** A second live category: where archiving a category moves its items. */
  spareCategoryId: string;
  itemId: string;
  /** A promotion on `itemId`, active, in a window long past. */
  specialId: string;
  restaurantId: string;
};

type TenantRoute = {
  name: string;
  ownerOnly: boolean;
  call: (target: Target) => Promise<Response>;
};

const harnessItem = "Harness item";
/** Every fixture item starts with this photo, so removing it is a real change. */
const fixturePhoto = "restaurants/harness/fixture-photo";
const harnessCategory = "Harness category";
const harnessRate = "31.5";
const renamedByHarness = "Renamed by the harness";
const harnessSpecial = "Harness special";
const harnessBundle = "Harness bundle";
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
 * Closures the delete route is aimed at, and the ones the add route makes: all far
 * ahead (about 600 days, inside the two years a closure may be saved for, and
 * before any booking another file makes) and at 03:00, so no closure here is ever
 * over another file's booking or in the way of one. They are removed at the end.
 */
const plantedClosureReason = "Harness planted closure";
const addedClosureReason = "Harness added closure";
const farDate = (extraDays: number) =>
  addDays(localToday(new Date(), "Africa/Harare"), 600 + extraDays);
const plantedClosures: { id: string; restaurantId: string }[] = [];
const plantClosure = async (restaurantId: string) => {
  const id = crypto.randomUUID();
  const day = farDate(1);
  await owner.db.insert(closures).values({
    id,
    restaurantId,
    // 03:00 to 03:30 in Harare, which is UTC+2.
    startsAt: new Date(`${day}T01:00:00Z`),
    endsAt: new Date(`${day}T01:30:00Z`),
    reason: plantedClosureReason,
  });
  plantedClosures.push({ id, restaurantId });
  return id;
};
const closureParams = (closureId: string) => ({ params: Promise.resolve({ closureId }) });
const closuresIn = (restaurantId: string, reason: string) =>
  owner.db
    .select({ id: closures.id })
    .from(closures)
    .where(and(eq(closures.restaurantId, restaurantId), eq(closures.reason, reason)));
/** Whether the closures planted since `mark` in a restaurant are all still there. */
const closuresUnremoved = async (restaurantId: string, mark: number) =>
  (
    await Promise.all(
      plantedClosures
        .slice(mark)
        .filter((closure) => closure.restaurantId === restaurantId)
        .map(async ({ id }) => (await owner.db.select().from(closures).where(eq(closures.id, id))).length),
    )
  ).every((found) => found === 1);
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
/** The first Sunday after today, where the fixture period (12:00 to 12:30) is, on Harare's calendar. */
const nextSunday = () => {
  let day = addDays(localToday(new Date(), "Africa/Harare"), 1);
  while (weekdayOf(day) !== 0) day = addDays(day, 1);
  return day;
};
const staffBookingForm = (fields: Record<string, string> = {}) =>
  form({
    party: "2",
    date: nextSunday(),
    time: "12:00",
    name: `${plantedBookingPrefix}${crypto.randomUUID()}`,
    ...fields,
  });
const postStaffBooking = async (fields: Record<string, string> = {}, init?: { path?: string; headers?: Record<string, string> }) =>
  (await import("@/app/api/bookings/route")).POST(
    request(init?.path ?? "/api/bookings", { method: "POST", headers: init?.headers, body: staffBookingForm(fields) }),
  );
const postMove = async (bookingId: string, tableId: string, init?: { path?: string; headers?: Record<string, string> }) =>
  (await import("@/app/api/bookings/[bookingId]/move/route")).POST(
    request(init?.path ?? `/api/bookings/${bookingId}/move`, {
      method: "POST",
      headers: init?.headers,
      body: form({ tableId }),
    }),
    bookingParams(bookingId),
  );
const form = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
};
const photoForm = async () => {
  const jpeg = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#c33" },
  })
    .jpeg()
    .toBuffer();
  const body = new FormData();
  body.set("photo", new File([new Uint8Array(jpeg)], "dish.jpg", { type: "image/jpeg" }));
  return body;
};
const itemParams = ({ itemId }: Target) => ({ params: Promise.resolve({ itemId }) });
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
    // Owners and staff alike (S-26): the one item edit a staff context may make.
    name: "POST /api/menu/items/[itemId]/availability",
    ownerOnly: false,
    call: async (target) =>
      (await import("@/app/api/menu/items/[itemId]/availability/route")).POST(
        request(`/api/menu/items/${target.itemId}/availability`, {
          method: "POST",
          body: form({ available: "false" }),
        }),
        { params: Promise.resolve({ itemId: target.itemId }) },
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
            priceZig: "300",
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
  {
    // The item is in the form, like the item's category. The window is clear of
    // the fixture special's, so an owner's call is not an overlap.
    name: "POST /api/menu/specials",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/specials/route")).POST(
        request("/api/menu/specials", {
          method: "POST",
          body: form({
            menuItemId: target.itemId,
            title: harnessSpecial,
            priceUsd: "6",
            startDate: "2031-01-01",
            endDate: "2031-01-02",
          }),
        }),
      ),
  },
  {
    // The category is in the form, like an item's. The window is long past, so
    // the special never overlaps anything.
    name: "POST /api/menu/bundles",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/bundles/route")).POST(
        request("/api/menu/bundles", {
          method: "POST",
          body: form({
            name: harnessBundle,
            description: "What's included",
            priceUsd: "9",
            categoryId: target.categoryId,
            title: harnessSpecial,
            startDate: "2031-03-01",
            endDate: "2031-03-02",
          }),
        }),
      ),
  },
  {
    name: "POST /api/menu/specials/[specialId]/active",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/specials/[specialId]/active/route")).POST(
        request(`/api/menu/specials/${target.specialId}/active`, {
          method: "POST",
          body: form({ active: "false" }),
        }),
        { params: Promise.resolve({ specialId: target.specialId }) },
      ),
  },
  {
    name: "POST /api/menu/items/[itemId]/photo",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/items/[itemId]/photo/route")).POST(
        request(`/api/menu/items/${target.itemId}/photo`, {
          method: "POST",
          body: await photoForm(),
        }),
        itemParams(target),
      ),
  },
  {
    name: "POST /api/menu/items/[itemId]/photo/remove",
    ownerOnly: true,
    call: async (target) =>
      (await import("@/app/api/menu/items/[itemId]/photo/remove/route")).POST(
        request(`/api/menu/items/${target.itemId}/photo/remove`, { method: "POST" }),
        itemParams(target),
      ),
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
  {
    // Removing can't be undone, so it takes a closure planted in the target's
    // restaurant for the purpose.
    name: "POST /api/bookings/closures/[closureId]/delete",
    ownerOnly: true,
    call: async (target) => {
      const closureId = [fixtures.a.periodId, fixtures.b.periodId].includes(target.periodId)
        ? await plantClosure(target.restaurantId)
        : target.periodId;
      return (await import("@/app/api/bookings/closures/[closureId]/delete/route")).POST(
        request(`/api/bookings/closures/${closureId}/delete`, { method: "POST" }),
        closureParams(closureId),
      );
    },
  },
  bookingAction("seat", "confirmed"),
  bookingAction("finish", "seated"),
  bookingAction("no-show", "confirmed"),
  bookingAction("cancel", "confirmed"),
  {
    // Each call books a table planted for it, so no call finds another's booking in its way.
    name: "POST /api/bookings",
    ownerOnly: false,
    call: async (target) => {
      const tableId = [fixtures.a.tableId, fixtures.b.tableId].includes(target.tableId)
        ? await plantTable(target.restaurantId)
        : target.tableId;
      return postStaffBooking({ tableId });
    },
  },
  {
    // Each call moves a booking planted for it to the restaurant's second fixture table.
    name: "POST /api/bookings/[bookingId]/move",
    ownerOnly: false,
    call: async (target) => {
      const bookingId = [fixtures.a.tableId, fixtures.b.tableId].includes(target.tableId)
        ? await plantBooking(target, "confirmed")
        : target.tableId;
      return postMove(bookingId, regenerationTarget(target.tableId));
    },
  },
  {
    // The table is in the form, because the form chooses it. Each call seats at a
    // table planted for it: a walk-in holds its table, so the fixture's can't be
    // used twice. Any other id, like the made-up ones tried below, is aimed at as it is.
    name: "POST /api/bookings/walk-in",
    ownerOnly: false,
    call: async (target) => {
      const tableId = [fixtures.a.tableId, fixtures.b.tableId].includes(target.tableId)
        ? await plantTable(target.restaurantId)
        : target.tableId;
      return (await import("@/app/api/bookings/walk-in/route")).POST(
        request("/api/bookings/walk-in", {
          method: "POST",
          body: form({ tableId, party: "2" }),
        }),
      );
    },
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
    // The restaurant is the session's: nothing in this request names one.
    name: "POST /api/menu/exchange-rate",
    call: async (fields, init) =>
      (await import("@/app/api/menu/exchange-rate/route")).POST(
        request(init?.path ?? "/api/menu/exchange-rate", {
          method: "POST",
          headers: init?.headers,
          body: form({ usdToZig: harnessRate, ...fields }),
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
  {
    // Each call adds a closure of its own, far ahead and at 03:00 (see plantClosure).
    name: "POST /api/bookings/closures",
    call: async (fields, init) =>
      (await import("@/app/api/bookings/closures/route")).POST(
        request(init?.path ?? "/api/bookings/closures", {
          method: "POST",
          headers: init?.headers,
          body: form({
            startDate: farDate(2),
            startTime: "03:00",
            endTime: "03:30",
            reason: addedClosureReason,
            ...fields,
          }),
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
    spareCategoryId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    specialId: crypto.randomUUID(),
    tableId: crypto.randomUUID(),
    regeneratedTableId: crypto.randomUUID(),
    periodId: crypto.randomUUID(),
    restaurantId: aOwner.restaurantId,
  },
  b: {
    staffId: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    spareCategoryId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    specialId: crypto.randomUUID(),
    tableId: crypto.randomUUID(),
    regeneratedTableId: crypto.randomUUID(),
    periodId: crypto.randomUUID(),
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
      photoKey: fixturePhoto,
    })),
  );
  await owner.db.insert(specials).values(
    Object.values(fixtures).map(({ specialId, itemId, restaurantId }) => ({
      id: specialId,
      restaurantId,
      menuItemId: itemId,
      title: fixtureName,
      specialPriceUsd: "6",
      startsAt: new Date("2020-01-01T00:00:00Z"),
      endsAt: new Date("2020-01-02T00:00:00Z"),
    })),
  );
  pristine.a = await menuFixtureState(fixtures.a);
  pristine.b = await menuFixtureState(fixtures.b);
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
  await resetMenuFixtures();
});

afterAll(async () => {
  await owner.db
    .delete(bookings)
    .where(inArray(bookings.manageToken, [fixtureManageToken("a"), fixtureManageToken("b")]));
  for (const { staffId } of Object.values(fixtures)) {
    await owner.db.delete(staff).where(eq(staff.id, staffId));
  }
  await owner.db.delete(exchangeRates).where(eq(exchangeRates.usdToZig, harnessRate));
  await owner.db
    .delete(specials)
    .where(inArray(specials.title, [harnessSpecial, fixtureName]));
  await owner.db
    .delete(menuItems)
    .where(inArray(menuItems.name, [harnessItem, harnessBundle, fixtureName]));
  await owner.db.delete(bookings).where(like(bookings.guestName, `${plantedBookingPrefix}%`));
  // Walk-ins and bookings made on the tables the harness planted, before those go.
  if (planted.length > 0) {
    await owner.db.delete(bookings).where(inArray(bookings.tableId, planted.map(({ id }) => id)));
  }
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
    .delete(closures)
    .where(inArray(closures.reason, [plantedClosureReason, addedClosureReason]));
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

/**
 * Puts the menu fixtures back as they were: the routes rename, archive, reprice
 * and mark them sold out, change their photo, and add and switch promotions and bundles.
 */
async function resetMenuFixtures() {
  const all = Object.values(fixtures);
  await owner.db.delete(specials).where(eq(specials.title, harnessSpecial));
  await owner.db.delete(menuItems).where(eq(menuItems.name, harnessBundle));
  await owner.db
    .update(specials)
    .set({ active: true })
    .where(inArray(specials.id, all.map((f) => f.specialId)));
  await owner.db
    .update(categories)
    .set({ name: fixtureName, archivedAt: null, sortOrder: 0 })
    .where(inArray(categories.id, all.flatMap((f) => [f.categoryId, f.spareCategoryId])));
  await owner.db
    .update(menuItems)
    .set({
      name: fixtureName,
      archivedAt: null,
      priceUsd: "8.50",
      priceZig: null,
      available: true,
      photoKey: fixturePhoto,
    })
    .where(inArray(menuItems.id, all.map((f) => f.itemId)));
  for (const { itemId, categoryId } of all) {
    await owner.db.update(menuItems).set({ categoryId }).where(eq(menuItems.id, itemId));
  }
}

/** What the menu routes would change in a fixture's restaurant. */
const menuFixtureState = async ({ categoryId, spareCategoryId, itemId }: Target) => {
  const promotions = await owner.db
    .select({ id: specials.id, title: specials.title, active: specials.active })
    .from(specials)
    .where(eq(specials.menuItemId, itemId));
  const rows = await owner.db
    .select({ id: categories.id, name: categories.name, archivedAt: categories.archivedAt, sortOrder: categories.sortOrder })
    .from(categories)
    .where(inArray(categories.id, [categoryId, spareCategoryId]));
  const [item] = await owner.db
    .select({
      name: menuItems.name,
      categoryId: menuItems.categoryId,
      archivedAt: menuItems.archivedAt,
      priceUsd: menuItems.priceUsd,
      priceZig: menuItems.priceZig,
      available: menuItems.available,
      photoKey: menuItems.photoKey,
    })
    .from(menuItems)
    .where(eq(menuItems.id, itemId));
  // Bundles the bundle route would add to the fixture's categories.
  const bundles = await owner.db
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(
      and(
        inArray(menuItems.categoryId, [categoryId, spareCategoryId]),
        eq(menuItems.visibility, "special_only"),
      ),
    );
  return {
    bundles,
    categories: rows.sort((x, y) => x.id.localeCompare(y.id)),
    item,
    specials: promotions.sort((x, y) => x.id.localeCompare(y.id)),
  };
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

/** The rates the exchange rate route would add, in any restaurant. */
const harnessRates = (restaurantId: string) =>
  owner.db
    .select({ id: exchangeRates.id })
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.restaurantId, restaurantId),
        eq(exchangeRates.usdToZig, harnessRate),
      ),
    );

const photoOf = async (itemId: string) =>
  (await owner.db.select().from(menuItems).where(eq(menuItems.id, itemId)))[0].photoKey;

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
      const stored = storage.calls;
      const bTable = await tableStanding(fixtures.b.tableId);
      const bPeriod = await periodStanding(fixtures.b.periodId);
      const mark = planted.length;
      const periodMark = plantedPeriods.length;
      const bookingMark = plantedBookings.length;
      const closureMark = plantedClosures.length;
      const closuresInB = (await closuresIn(fixtures.b.restaurantId, addedClosureReason)).length;

      const status = await statusOf(() => route.call(fixtures.b));

      expect([403, 404]).toContain(status);
      expect(storage.calls).toBe(stored);
      expect(await photoOf(fixtures.b.itemId)).toBe(fixturePhoto);
      expect(await displayName(fixtures.b.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.b.staffId)).toEqual(untouched);
      expect(await harnessItems(fixtures.b.restaurantId)).toEqual([]);
      expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(itemsInA);
      expect(await menuFixtureState(fixtures.b)).toEqual(pristine.b);
      expect(await tableStanding(fixtures.b.tableId)).toEqual(bTable);
      expect(await unarchived(fixtures.b.restaurantId, mark)).toBe(true);
      expect(await periodStanding(fixtures.b.periodId)).toEqual(bPeriod);
      expect(await unremoved(fixtures.b.restaurantId, periodMark)).toBe(true);
      expect(await bookingsAsPlanted(fixtures.b.restaurantId, bookingMark)).toBe(true);
      expect(await closuresUnremoved(fixtures.b.restaurantId, closureMark)).toBe(true);
      expect(await closuresIn(fixtures.b.restaurantId, addedClosureReason)).toHaveLength(closuresInB);
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
      const stored = storage.calls;
      const aTable = await tableStanding(fixtures.a.tableId);
      const aPeriod = await periodStanding(fixtures.a.periodId);
      const mark = planted.length;
      const periodMark = plantedPeriods.length;
      const closureMark = plantedClosures.length;

      expect(await statusOf(() => route.call(fixtures.a))).toBe(403);
      expect(storage.calls).toBe(stored);
      expect(await photoOf(fixtures.a.itemId)).toBe(fixturePhoto);
      expect(await displayName(fixtures.a.staffId)).toBe(fixtureName);
      expect(await standing(fixtures.a.staffId)).toEqual(untouched);
      expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(items);
      expect(await menuFixtureState(fixtures.a)).toEqual(pristine.a);
      expect(await tableStanding(fixtures.a.tableId)).toEqual(aTable);
      expect(await unarchived(fixtures.a.restaurantId, mark)).toBe(true);
      expect(await periodStanding(fixtures.a.periodId)).toEqual(aPeriod);
      expect(await unremoved(fixtures.a.restaurantId, periodMark)).toBe(true);
      expect(await closuresUnremoved(fixtures.a.restaurantId, closureMark)).toBe(true);
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
      const rates = (await harnessRates(aStaff.restaurantId)).length;
      const newTables = (await harnessTables(aStaff.restaurantId)).length;

      expect(
        await statusOf(() => route.call({ contactPhone: "+263771234567" })),
      ).toBe(403);

      expect(await restaurantRow(aStaff.restaurantId)).toEqual(before);
      expect(await addedStaff()).toHaveLength(added);
      expect(await harnessCategories(aStaff.restaurantId)).toHaveLength(newCategories);
      expect(await harnessRates(aStaff.restaurantId)).toHaveLength(rates);
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

  it("a new exchange rate is restaurant A's, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const before = (await harnessRates(fixtures.a.restaurantId)).length;
    const id = fixtures.b.restaurantId;

    const response = await sessionRoutes[3].call(
      { restaurantId: id, restaurant_id: id },
      {
        headers: { "x-restaurant-id": id },
        path: `/api/menu/exchange-rate?restaurantId=${id}&restaurant_id=${id}`,
      },
    );

    expect(response.status).toBeLessThan(400);
    expect(await harnessRates(fixtures.b.restaurantId)).toEqual([]);
    expect(await harnessRates(fixtures.a.restaurantId)).toHaveLength(before + 1);
  });

  it.each(["0", "-1", "abc", ""])("a rate of %j is a 400 the form can show", async (usdToZig) => {
    session.identity = aOwner.key;
    const before = (await harnessRates(fixtures.a.restaurantId)).length;

    const response = await sessionRoutes[3].call({ usdToZig });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Enter the rate as a number above 0, like 26.2.",
    });
    expect(await harnessRates(fixtures.a.restaurantId)).toHaveLength(before);
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

describe("the specials routes", () => {
  const harnessSpecials = (restaurantId: string) =>
    owner.db
      .select({ id: specials.id })
      .from(specials)
      .where(and(eq(specials.restaurantId, restaurantId), eq(specials.title, harnessSpecial)));

  it("a new special is the session's restaurant's, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const id = fixtures.b.restaurantId;
    const { POST } = await import("@/app/api/menu/specials/route");

    const response = await POST(
      request(`/api/menu/specials?restaurantId=${id}`, {
        method: "POST",
        headers: { "x-restaurant-id": id },
        body: form({
          menuItemId: fixtures.a.itemId,
          title: harnessSpecial,
          priceUsd: "6",
          startDate: "2031-01-01",
          restaurantId: id,
          restaurant_id: id,
        }),
      }),
    );

    expect(response.status).toBeLessThan(400);
    expect(await harnessSpecials(fixtures.b.restaurantId)).toEqual([]);
    expect(await harnessSpecials(fixtures.a.restaurantId)).toHaveLength(1);
  });

  it("a second special in the same dates is a 409 that says why", async () => {
    session.identity = aOwner.key;
    const create = routes.find((route) => route.name === "POST /api/menu/specials")!;
    expect(await statusOf(() => create.call(fixtures.a))).toBeLessThan(400);

    const again = await create.call(fixtures.a);

    expect(again.status).toBe(409);
    expect(await harnessSpecials(fixtures.a.restaurantId)).toHaveLength(1);
  });
});

describe("marking an item sold out", () => {
  const availability = async (itemId: string) =>
    (
      await owner.db
        .select({ available: menuItems.available })
        .from(menuItems)
        .where(eq(menuItems.id, itemId))
    )[0].available;

  const route = routes.find((route) => route.name.endsWith("/availability"))!;

  it("a staff member can, in their own restaurant", async () => {
    session.identity = aStaff.key;
    expect(await statusOf(() => route.call(fixtures.a))).toBeLessThan(400);
    expect(await availability(fixtures.a.itemId)).toBe(false);
  });

  it("an owner can, in their own restaurant", async () => {
    session.identity = aOwner.key;
    expect(await statusOf(() => route.call(fixtures.a))).toBeLessThan(400);
    expect(await availability(fixtures.a.itemId)).toBe(false);
  });

  it("a staff member can't do it to another restaurant's item, and it stays on", async () => {
    session.identity = aStaff.key;
    expect(await statusOf(() => route.call(fixtures.b))).toBe(404);
    expect(await availability(fixtures.b.itemId)).toBe(true);
  });

  it("a staff member still gets a 403 on the owner's item routes, and the item stays on", async () => {
    session.identity = aStaff.key;
    const create = routes.find((route) => route.name === "POST /api/menu/items")!;
    const before = (await harnessItems(fixtures.a.restaurantId)).length;

    expect(await statusOf(() => create.call(fixtures.a))).toBe(403);
    expect(await harnessItems(fixtures.a.restaurantId)).toHaveLength(before);
  });
});

describe("the photo route", () => {
  const upload = async (body: FormData) => {
    session.identity = aOwner.key;
    const { POST } = await import("@/app/api/menu/items/[itemId]/photo/route");
    const target = fixtures.a;
    return POST(
      request(`/api/menu/items/${target.itemId}/photo`, { method: "POST", body }),
      itemParams(target),
    );
  };
  const file = (bytes: Uint8Array | string) =>
    new File([bytes as BlobPart], "x.jpg", { type: "image/jpeg" });

  it.each([
    ["no file", async () => form({}), "Choose a photo."],
    [
      "a file that isn't a photo",
      async () => {
        const body = new FormData();
        body.set("photo", file("<svg onload=alert(1)/>"));
        return body;
      },
      "That file couldn't be read as a photo. Try another.",
    ],
  ])("%s is a 400 the form can show", async (_name, makeBody, error) => {
    const stored = storage.calls;
    const response = await upload(await makeBody());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(storage.calls).toBe(stored);
    expect(await photoOf(fixtures.a.itemId)).toBe(fixturePhoto);
  });

  it("a photo over the limit is a 413 before anything is decoded or stored", async () => {
    const body = new FormData();
    body.set("photo", file(new Uint8Array(4 * 1024 * 1024 + 1)));
    const stored = storage.calls;

    const response = await upload(body);

    expect(response.status).toBe(413);
    expect(storage.calls).toBe(stored);
  });

  it("a restaurant id in the form can't move a photo to another restaurant's item", async () => {
    const body = await photoForm();
    body.set("restaurantId", fixtures.b.restaurantId);
    const stored = storage.calls;

    session.identity = aOwner.key;
    const { POST } = await import("@/app/api/menu/items/[itemId]/photo/route");
    const status = await statusOf(() =>
      POST(
        request(`/api/menu/items/${fixtures.b.itemId}/photo?restaurantId=${fixtures.b.restaurantId}`, {
          method: "POST",
          headers: { "x-restaurant-id": fixtures.b.restaurantId },
          body,
        }),
        itemParams(fixtures.b),
      ),
    );

    expect(status).toBe(404);
    expect(storage.calls).toBe(stored);
    expect(await photoOf(fixtures.b.itemId)).toBe(fixturePhoto);
  });
});

describe("the tables route", () => {
  const addTable = sessionRoutes.find((route) => route.name === "POST /api/tables")!;

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
  const [saveRules, enable, addPeriod, addClosure] = sessionRoutes.slice(
    sessionRoutes.findIndex((route) => route.name === "POST /api/bookings/settings"),
  );
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

  it("a new closure joins the session's restaurant, whatever id the request names", async () => {
    session.identity = aOwner.key;
    const { fields, init } = smuggledB();
    const reason = `${addedClosureReason} smuggled`;
    const before = (await closuresIn(fixtures.a.restaurantId, reason)).length;

    const response = await addClosure.call({ ...fields, reason }, init("/api/bookings/closures"));

    expect(response.status).toBeLessThan(400);
    expect(await closuresIn(fixtures.b.restaurantId, reason)).toEqual([]);
    expect(await closuresIn(fixtures.a.restaurantId, reason)).toHaveLength(before + 1);
    await owner.db.delete(closures).where(eq(closures.reason, reason));
  });

  it("a staff context adds no closure", async () => {
    session.identity = aStaff.key;
    const before = (await closuresIn(fixtures.a.restaurantId, addedClosureReason)).length;

    expect(await statusOf(() => addClosure.call())).toBe(403);

    expect(await closuresIn(fixtures.a.restaurantId, addedClosureReason)).toHaveLength(before);
  });

  it("restaurant B's closure can't be removed with B's id in the request either: a 404", async () => {
    session.identity = aOwner.key;
    const id = await plantClosure(fixtures.b.restaurantId);

    const status = await statusOf(async () =>
      (await import("@/app/api/bookings/closures/[closureId]/delete/route")).POST(
        request(`/api/bookings/closures/${id}/delete?restaurantId=${fixtures.b.restaurantId}`, {
          method: "POST",
          headers: { "x-restaurant-id": fixtures.b.restaurantId },
          body: form({ restaurantId: fixtures.b.restaurantId }),
        }),
        closureParams(id),
      ),
    );

    expect(status).toBe(404);
    expect(await closuresUnremoved(fixtures.b.restaurantId, plantedClosures.length - 1)).toBe(true);
  });

  it.each([
    ["a date that isn't one", { startDate: "2026-02-31" }],
    ["the year 0000", { startDate: "0000-01-01" }],
    ["the last date there is", { startDate: "9999-12-31" }],
    ["an end past the limit", { endDate: "9999-12-31" }],
    ["a NUL in the reason", { reason: "a\0b" }],
    ["a reason over 200 characters", { reason: "x".repeat(201) }],
    ["half the times", { endTime: "" }],
    ["no date", { startDate: "" }],
  ])("a crafted closure (%s) is a 400, not an error, and saves nothing", async (_label, fields) => {
    session.identity = aOwner.key;
    const before = (await owner.db.select().from(closures).where(eq(closures.restaurantId, fixtures.a.restaurantId))).length;

    const response = await addClosure.call(fields);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/\w/);
    expect((await owner.db.select().from(closures).where(eq(closures.restaurantId, fixtures.a.restaurantId))).length).toBe(before);
  });

  it("a closure over a confirmed booking is a 409 that lists it by name, time and party, never a phone", async () => {
    session.identity = aOwner.key;
    const day = farDate(40);
    const tableId = await plantTable(fixtures.a.restaurantId);
    const phone = "+263779998888";
    await owner.db.insert(bookings).values({
      ...aBooking(fixtures.a.restaurantId, tableId, `${day}T17:00:00Z`, `${day}T18:30:00Z`),
      guestName: `${plantedBookingPrefix}Closure ${crypto.randomUUID()}`,
      guestPhone: phone,
      partySize: 3,
    });

    const response = await addClosure.call({ startDate: day, startTime: "19:00", endTime: "22:00" });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.bookings).toHaveLength(1);
    expect(body.bookings[0]).toMatchObject({ partySize: 3, summary: expect.stringContaining("19:00 · Harness booking Closure") });
    expect(JSON.stringify(body)).not.toContain(phone);
    const onThatDay = await owner.db
      .select({ id: closures.id })
      .from(closures)
      .where(and(eq(closures.restaurantId, fixtures.a.restaurantId), eq(closures.startsAt, new Date(`${day}T17:00:00Z`))));
    expect(onThatDay).toEqual([]);
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
        // Nor is a blank table: on Add booking it means automatic.
        const categoryId = staffId || "not-a-uuid";
        const target = {
          ...fixtures.a,
          staffId,
          categoryId,
          spareCategoryId: `${categoryId}-spare`,
          itemId: categoryId,
          specialId: categoryId,
          tableId: staffId || "not-a-uuid",
          periodId: staffId,
        };
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
      const ratesBefore = (await harnessRates(fixtures.a.restaurantId)).length;

      expect(await statusOf(() => route.call())).toBe(403);

      expect(await restaurantRow(fixtures.a.restaurantId)).toEqual(restaurantBefore);
      expect(await addedStaff()).toHaveLength(addedBefore);
      expect(await harnessCategories(fixtures.a.restaurantId)).toHaveLength(categoriesBefore);
      expect(await harnessRates(fixtures.a.restaurantId)).toHaveLength(ratesBefore);
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

describe("seat walk-in", () => {
  const walkInPost = async (fields: Record<string, string>, path = "/api/bookings/walk-in") =>
    (await import("@/app/api/bookings/walk-in/route")).POST(
      request(path, { method: "POST", body: form(fields) }),
    );
  const walkInsAt = (tableId: string) =>
    owner.db.select().from(bookings).where(eq(bookings.tableId, tableId));

  it.each([aOwner, aStaff].map((who) => [who.key, who] as const))("%s: an owner or staff seats one in their restaurant (S-26)", async (_key, who) => {
    session.identity = who.key;
    const tableId = await plantTable(fixtures.a.restaurantId);

    const response = await walkInPost({ tableId, party: "3" });

    expect(response.status).toBeLessThan(400);
    expect(await walkInsAt(tableId)).toEqual([
      expect.objectContaining({ guestName: "Walk-in", status: "seated", source: "staff", partySize: 3 }),
    ]);
  });

  it("another restaurant's table is a 404 and nothing is seated; a malformed or unknown one too", async () => {
    session.identity = aOwner.key;
    const theirs = await plantTable(fixtures.b.restaurantId);
    for (const tableId of [theirs, "not-a-uuid", "", "'; drop table tables; --", "a\0b", crypto.randomUUID()]) {
      expect(await statusOf(() => walkInPost({ tableId, party: "2" }))).toBe(404);
    }
    expect(await walkInsAt(theirs)).toEqual([]);
  });

  it("a restaurant id in the query, headers or body can't move it to B's table", async () => {
    session.identity = aOwner.key;
    const b = fixtures.b.restaurantId;
    const theirs = await plantTable(b);

    const status = await statusOf(async () =>
      (await import("@/app/api/bookings/walk-in/route")).POST(
        request(`/api/bookings/walk-in?restaurantId=${b}&restaurant_id=${b}`, {
          method: "POST",
          headers: { "x-restaurant-id": b },
          body: form({ tableId: theirs, party: "2", restaurantId: b, restaurant_id: b }),
        }),
      ),
    );

    expect(status).toBe(404);
    expect(await walkInsAt(theirs)).toEqual([]);
  });

  it.each(["", "0", "101", "-1", "2.5", "abc", "1e2"])("a party size of %j is a 400 and nothing is seated", async (party) => {
    session.identity = aOwner.key;
    const tableId = await plantTable(fixtures.a.restaurantId);

    expect(await statusOf(() => walkInPost({ tableId, party }))).toBe(400);
    expect(await walkInsAt(tableId)).toEqual([]);
  });

  it("a second walk-in on the table is a 409 that says it is in use, and a booking soon gets the prompt", async () => {
    session.identity = aStaff.key;
    const tableId = await plantTable(fixtures.a.restaurantId);
    await walkInPost({ tableId, party: "2" });

    const again = await walkInPost({ tableId, party: "2" });

    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/^Table .+ is in use until \d\d:\d\d\./);

    const soon = await plantTable(fixtures.a.restaurantId);
    const start = new Date(Date.now() + 20 * 60_000);
    await owner.db.insert(bookings).values(
      aBooking(fixtures.a.restaurantId, soon, start.toISOString(), new Date(start.getTime() + 3_600_000).toISOString()),
    );
    const prompt = await walkInPost({ tableId: soon, party: "2" });
    expect(prompt.status).toBe(409);
    expect((await prompt.json()).error).toMatch(
      /^Table .+ has a booking at \d\d:\d\d — move that booking, or seat the walk-in elsewhere$/,
    );
    expect(await walkInsAt(soon)).toHaveLength(1);
  });

  it("is a 401 with no session, and seats nothing", async () => {
    session.identity = "";
    const tableId = await plantTable(fixtures.a.restaurantId);

    expect(await statusOf(() => walkInPost({ tableId, party: "2" }))).toBe(401);
    expect(await walkInsAt(tableId)).toEqual([]);
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

describe("staff add and move", () => {
  const standingOf = async (id: string) => {
    const [row] = await owner.db.select().from(bookings).where(eq(bookings.id, id));
    return row;
  };
  const nameOf = () => `${plantedBookingPrefix}${crypto.randomUUID()}`;
  const bookedAs = (guestName: string) =>
    owner.db.select().from(bookings).where(eq(bookings.guestName, guestName));

  it.each([aOwner, aStaff])("%s: owners and staff both add a booking, as source staff, on their restaurant's table", async (who) => {
    session.identity = who.key;
    const guestName = nameOf();
    const tableId = await plantTable(fixtures.a.restaurantId);

    const response = await postStaffBooking({ guestName, name: guestName, tableId });

    expect(response.status).toBeLessThan(400);
    expect(await bookedAs(guestName)).toEqual([
      expect.objectContaining({ restaurantId: fixtures.a.restaurantId, tableId, source: "staff", status: "confirmed", guestPhone: null }),
    ]);
  });

  it("a table of restaurant B is a 404 and books nothing in either restaurant", async () => {
    session.identity = aOwner.key;
    const guestName = nameOf();

    const status = await statusOf(() => postStaffBooking({ name: guestName, tableId: fixtures.b.tableId }));

    expect(status).toBe(404);
    expect(await bookedAs(guestName)).toEqual([]);
  });

  it("a restaurant id in the query, headers or body can't send the booking to B", async () => {
    session.identity = aOwner.key;
    const guestName = nameOf();
    const b = fixtures.b.restaurantId;
    const tableId = await plantTable(fixtures.a.restaurantId);

    const response = await postStaffBooking(
      { name: guestName, tableId, restaurantId: b, restaurant_id: b },
      { path: `/api/bookings?restaurantId=${b}&restaurant_id=${b}`, headers: { "x-restaurant-id": b } },
    );

    expect(response.status).toBeLessThan(400);
    expect((await bookedAs(guestName)).map((row) => row.restaurantId)).toEqual([fixtures.a.restaurantId]);
  });

  it.each([
    ["party", { party: "0" }], ["a crafted date", { date: "2026-02-31" }], ["a date far away", { date: "9999-12-31" }],
    ["a crafted time", { time: "25:99" }], ["a NUL in the name", { name: "a\0b" }], ["a bad phone", { phone: "x" }],
  ])("%s is a refusal, not a 500", async (_label, fields) => {
    session.identity = aStaff.key;
    const status = await statusOf(() => postStaffBooking(fields));
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });

  it("a taken table is a 409 with a message, not a 500", async () => {
    session.identity = aStaff.key;
    const tableId = await plantTable(fixtures.a.restaurantId);
    expect((await postStaffBooking({ tableId })).status).toBeLessThan(400);

    const second = await postStaffBooking({ tableId });

    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/free|taken/);
  });

  it.each([aOwner, aStaff])("%s: moves a booking, and the move is audited with who did it", async (who) => {
    session.identity = who.key;
    const id = await plantBooking(fixtures.a, "confirmed");

    const response = await postMove(id, fixtures.a.regeneratedTableId);

    expect(response.status).toBeLessThan(400);
    expect((await standingOf(id)).tableId).toBe(fixtures.a.regeneratedTableId);
    const [entry] = await owner.db.select().from(auditLog).where(eq(auditLog.entityId, id));
    expect(entry).toMatchObject({ restaurantId: fixtures.a.restaurantId, actorType: "staff", action: "booking.move" });
  });

  it("A's booking can't be moved onto B's table, and B's booking can't be moved at all", async () => {
    session.identity = aOwner.key;
    const mine = await plantBooking(fixtures.a, "confirmed");
    const theirs = await plantBooking(fixtures.b, "confirmed");

    expect(await statusOf(() => postMove(mine, fixtures.b.regeneratedTableId))).toBe(404);
    expect(await statusOf(() => postMove(theirs, fixtures.a.regeneratedTableId))).toBe(404);
    expect(await statusOf(() => postMove(theirs, fixtures.b.regeneratedTableId))).toBe(404);

    expect((await standingOf(mine)).tableId).toBe(fixtures.a.tableId);
    expect((await standingOf(theirs)).tableId).toBe(fixtures.b.tableId);
  });

  it("a restaurant id in the query, headers or body can't move B's booking", async () => {
    session.identity = aOwner.key;
    const theirs = await plantBooking(fixtures.b, "confirmed");
    const b = fixtures.b.restaurantId;

    const status = await statusOf(() =>
      postMove(theirs, fixtures.b.regeneratedTableId, {
        path: `/api/bookings/${theirs}/move?restaurantId=${b}`,
        headers: { "x-restaurant-id": b },
      }),
    );

    expect(status).toBe(404);
    expect((await standingOf(theirs)).tableId).toBe(fixtures.b.tableId);
  });

  it("a malformed booking or table id is a 404, a missing table a 400, and a seated booking a 409", async () => {
    session.identity = aOwner.key;
    const id = await plantBooking(fixtures.a, "confirmed");
    const seated = await plantBooking(fixtures.a, "seated");

    for (const bad of ["not-a-uuid", "a\0b", "'; drop table bookings; --"]) {
      expect(await statusOf(() => postMove(bad, fixtures.a.regeneratedTableId))).toBe(404);
      expect(await statusOf(() => postMove(id, bad))).toBe(404);
    }
    expect(await statusOf(() => postMove(id, ""))).toBe(400);
    const refused = await postMove(seated, fixtures.a.regeneratedTableId);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/already seated/);
    expect((await standingOf(seated)).tableId).toBe(fixtures.a.tableId);
  });

  it("is a 401 with no session, and changes nothing", async () => {
    session.identity = "";
    const id = await plantBooking(fixtures.a, "confirmed");
    const guestName = nameOf();

    expect(await statusOf(() => postMove(id, fixtures.a.regeneratedTableId))).toBe(401);
    expect(await statusOf(() => postStaffBooking({ name: guestName }))).toBe(401);

    expect((await standingOf(id)).tableId).toBe(fixtures.a.tableId);
    expect(await bookedAs(guestName)).toEqual([]);
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
