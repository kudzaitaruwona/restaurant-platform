import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as savePeriod } from "@/app/api/bookings/periods/[periodId]/route";
import { POST as addPeriod } from "@/app/api/bookings/periods/route";
import { POST as saveRules } from "@/app/api/bookings/settings/route";
import { POST as setEnabled } from "@/app/api/bookings/settings/enabled/route";
import { bookingSettings, diningTables, restaurants, servicePeriods, staff } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import type { TenantContext } from "@/lib/tenant";
import {
  openOwnerDatabase,
  testDatabaseSettings,
} from "../../../../../test/integration/database";
import { statusOf } from "../../../../../test/integration/http";
import { BookingSettingsScreen } from "./booking-settings-screen";

/**
 * The booking settings screen and the routes behind it, on a restaurant of
 * their own. Faked: who's asking (access.int.test.ts covers the real seam) and
 * the App Router context the client form expects.
 */
const session = vi.hoisted(() => ({ tenant: undefined as unknown }));

vi.mock("@/lib/tenant", async (original) => ({
  ...(await original<typeof import("@/lib/tenant")>()),
  getTenantContext: async () => session.tenant as TenantContext,
}));

vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {} }),
}));

// A client form's props never reach static markup, so what it would ask once
// clicked is surfaced here beside the real form.
vi.mock("../../action-form", async (original) => {
  const { ActionForm } = await original<typeof import("../../action-form")>();
  return {
    ActionForm: (props: React.ComponentProps<typeof ActionForm>) => (
      <div data-confirmation={props.confirmation}>
        <ActionForm {...props} />
      </div>
    ),
  };
});

const owner = openOwnerDatabase();
const created: string[] = [];
let tenant: TenantContext;

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});

afterAll(async () => {
  await owner.db.delete(servicePeriods).where(inArray(servicePeriods.restaurantId, created));
  await owner.db.delete(diningTables).where(inArray(diningTables.restaurantId, created));
  // The restaurants stay behind: one with an owner can't lose it (S-26).
  await owner.pool.end();
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  const restaurantId = crypto.randomUUID();
  const staffId = crypto.randomUUID();
  await owner.db.insert(restaurants).values({
    id: restaurantId,
    name: "Mama's Kitchen",
    slug: `booking-screen-${restaurantId}`,
    menuToken: restaurantId,
    currencyMode: "usd_only",
  });
  await owner.db.insert(staff).values({
    id: staffId,
    restaurantId,
    email: `${staffId}@example.test`,
    displayName: "First Owner",
    role: "owner",
  });
  created.push(restaurantId);
  tenant = { restaurantId, staffId, role: "owner" };
  session.tenant = tenant;
});

const post = (path: string, fields: Record<string, string> = {}, headers: Record<string, string> = {}) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new NextRequest(new URL(path, "http://localhost:3000"), { method: "POST", body, headers });
};

const periodParams = (periodId: string) => ({ params: Promise.resolve({ periodId }) });
const screen = async () => renderToStaticMarkup(await BookingSettingsScreen());

const lunch = { name: "Lunch", weekday: "1", opensAt: "12:00", lastBookingAt: "14:00", closesAt: "15:00" };

const periods = () =>
  owner.db
    .select()
    .from(servicePeriods)
    .where(eq(servicePeriods.restaurantId, tenant.restaurantId));

const settingsRow = async () =>
  (
    await owner.db
      .select()
      .from(bookingSettings)
      .where(eq(bookingSettings.restaurantId, tenant.restaurantId))
  )[0];

const deleteConfirmation = (html: string, periodId: string) =>
  new RegExp(`data-confirmation="([^"]*)"><form[^>]*action="/api/bookings/periods/${periodId}/delete"`).exec(
    html,
  )?.[1];

/** Everything the gate asks for, and booking turned on. */
async function turnBookingOn() {
  await owner.db
    .update(restaurants)
    .set({ contactPhone: "+263771234567" })
    .where(eq(restaurants.id, tenant.restaurantId));
  await addPeriod(post("/api/bookings/periods", lunch));
  await owner.db.insert(diningTables).values({
    restaurantId: tenant.restaurantId,
    label: "1",
    capacity: 2,
    qrToken: crypto.randomUUID().replaceAll("-", "").slice(0, 22),
  });
  await setEnabled(post("/api/bookings/settings/enabled", { enabled: "true" }));
}

describe("/dashboard/bookings/settings", () => {
  it.each([
    ["on", true],
    ["off, so it still explains a switch-off", false],
  ])("names all four ways booking switches itself off while it's %s", async (_name, on) => {
    if (on) await turnBookingOn();

    const html = await screen();

    expect(html).toContain("switches itself off");
    expect(html).toContain("delete the last service period");
    expect(html).toContain("archive the last table");
    expect(html).toContain("walk-ins only");
    expect(html).toContain("clear the contact phone");
  });

  it("warns before deleting the last service period while booking is on", async () => {
    await turnBookingOn();
    const [{ id }] = await periods();

    expect(deleteConfirmation(await screen(), id)).toContain("online booking will switch off");
  });

  it("doesn't warn about a delete that can't switch booking off", async () => {
    await addPeriod(post("/api/bookings/periods", lunch));
    const [{ id }] = await periods();

    expect(deleteConfirmation(await screen(), id)).not.toContain("switch off");
  });

  it("doesn't warn while another service period remains", async () => {
    await turnBookingOn();
    await addPeriod(post("/api/bookings/periods", { ...lunch, weekday: "2" }));
    const [{ id }] = await periods();

    expect(deleteConfirmation(await screen(), id)).not.toContain("switch off");
  });

  it("gives the booking link and its QR code, for this restaurant's slug", async () => {
    const link = `${getEnv().NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/r/booking-screen-${tenant.restaurantId}/book`;

    const html = await screen();

    expect(html).toContain(`value="${link}"`);
    expect(html).toMatch(/<svg[\s\S]*<\/svg>/);
  });

  it("gives another restaurant's session its own link, never this one's", async () => {
    const other = crypto.randomUUID();
    await owner.db.insert(restaurants).values({
      id: other,
      name: "Somewhere else",
      slug: `booking-screen-${other}`,
      menuToken: other,
      currencyMode: "usd_only",
    });
    created.push(other);
    session.tenant = { restaurantId: other, staffId: tenant.staffId, role: "owner" };

    const html = await screen();

    expect(html).toContain(`/r/booking-screen-${other}/book`);
    expect(html).not.toContain(`/r/booking-screen-${tenant.restaurantId}/book`);
  });

  it("says guests will see that booking is off, until it's turned on", async () => {
    expect(await screen()).toContain("Guests who open the link will see that online booking is off");

    await turnBookingOn();

    expect(await screen()).not.toContain("Guests who open the link will see that online booking is off");
  });

  it("refuses staff with forbidden(), before any data renders", async () => {
    session.tenant = { ...tenant, role: "staff" };

    expect(await statusOf(() => BookingSettingsScreen())).toBe(403);
  });

  it("starts with booking off, what's missing, and the defaults filled in", async () => {
    const html = await screen();

    expect(html).toContain("Online booking is off");
    expect(html).toContain("add at least one service period");
    expect(html).toContain("add a table that can be booked online");
    expect(html).toContain("contact phone");
    expect(html).toContain("Turn online booking on");
    expect(html).toContain('name="slotIntervalMinutes"');
    expect(html).toMatch(/name="sittingMinutes"[^>]*value="90"/);
    expect(html).toMatch(/name="maxActiveBookingsPerPhone"[^>]*value="2"/);
  });

  it("says which timezone the times are in", async () => {
    await owner.db
      .update(restaurants)
      .set({ timezone: "Africa/Johannesburg" })
      .where(eq(restaurants.id, tenant.restaurantId));

    expect(await screen()).toContain("Africa/Johannesburg");
  });

  it("lists a day's periods with their times, and an add form for every day", async () => {
    await addPeriod(post("/api/bookings/periods", lunch));

    const html = await screen();

    expect(html).toContain("Monday");
    expect(html).toContain('value="Lunch"');
    expect(html).toContain('value="12:00"');
    expect(html).toContain('value="14:00"');
    expect(html).toContain('value="15:00"');
    expect(html.match(/action="\/api\/bookings\/periods"/g)).toHaveLength(7);
  });

  it("stops listing what's missing once it all exists, and offers to turn booking off when it's on", async () => {
    await owner.db
      .update(restaurants)
      .set({ contactPhone: "+263771234567" })
      .where(eq(restaurants.id, tenant.restaurantId));
    await addPeriod(post("/api/bookings/periods", lunch));
    await owner.db.insert(diningTables).values({
      restaurantId: tenant.restaurantId,
      label: "1",
      capacity: 2,
      qrToken: "a".repeat(22),
    });
    expect(await screen()).not.toContain("Before you can turn it on");

    await setEnabled(post("/api/bookings/settings/enabled", { enabled: "true" }));
    const html = await screen();

    expect(html).toContain("Online booking is on");
    expect(html).toContain("Turn online booking off");
  });
});

describe("the booking routes", () => {
  it("refuse staff before reading the body", async () => {
    session.tenant = { ...tenant, role: "staff" };
    const id = crypto.randomUUID();

    expect(await statusOf(() => saveRules(post("/api/bookings/settings")))).toBe(403);
    expect(await statusOf(() => setEnabled(post("/api/bookings/settings/enabled")))).toBe(403);
    expect(await statusOf(() => addPeriod(post("/api/bookings/periods", lunch)))).toBe(403);
    expect(
      await statusOf(() => savePeriod(post(`/api/bookings/periods/${id}`), periodParams(id))),
    ).toBe(403);
  });

  it("saves the rules and sends a plain post back to the page, or a 204 to the form", async () => {
    const rules = {
      slotIntervalMinutes: "30",
      sittingMinutes: "60",
      largePartySize: "6",
      largePartySittingMinutes: "100",
      bufferMinutes: "5",
      minLeadMinutes: "30",
      maxDaysAhead: "14",
      maxOnlinePartySize: "10",
      guestCancelCutoffMinutes: "60",
      maxActiveBookingsPerPhone: "3",
    };

    const plain = await saveRules(post("/api/bookings/settings", rules));
    expect(plain.status).toBe(303);
    expect(plain.headers.get("Location")).toBe("/dashboard/bookings/settings");
    const fetched = await saveRules(
      post("/api/bookings/settings", rules, { [FORM_FETCH_HEADER]: "1" }),
    );
    expect(fetched.status).toBe(204);

    expect(await settingsRow()).toMatchObject({
      slotIntervalMinutes: 30,
      sittingMinutes: 60,
      maxDaysAhead: 14,
      maxActiveBookingsPerPhone: 3,
      enabled: false,
    });
  });

  it("refuses a bad rule with a 400 that names it and saves none of them", async () => {
    const response = await saveRules(
      post("/api/bookings/settings", {
        slotIntervalMinutes: "20",
        sittingMinutes: "0",
        largePartySize: "5",
        largePartySittingMinutes: "120",
        bufferMinutes: "15",
        minLeadMinutes: "60",
        maxDaysAhead: "30",
        maxOnlinePartySize: "8",
        guestCancelCutoffMinutes: "120",
        maxActiveBookingsPerPhone: "2",
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Sitting length");
    expect((await settingsRow()).slotIntervalMinutes).toBe(15);
  });

  it("can't turn booking on while something's missing: a 409 that says what", async () => {
    const response = await setEnabled(post("/api/bookings/settings/enabled", { enabled: "true" }));

    expect(response.status).toBe(409);
    const { error } = await response.json();
    expect(error).toContain("service period");
    expect(error).toContain("table");
    expect(error).toContain("contact phone");
    expect((await settingsRow()).enabled).toBe(false);
  });

  it.each(["", "yes", "TRUE"])("refuses enabled = %j with a 400", async (enabled) => {
    const response = await setEnabled(post("/api/bookings/settings/enabled", { enabled }));

    expect(response.status).toBe(400);
  });

  it("adds a period, refuses an overlapping one with a 409 and times out of order with a 400", async () => {
    expect((await addPeriod(post("/api/bookings/periods", lunch))).status).toBe(303);

    const overlap = await addPeriod(
      post("/api/bookings/periods", { ...lunch, name: "Brunch", opensAt: "11:00", lastBookingAt: "12:00", closesAt: "13:00" }),
    );
    expect(overlap.status).toBe(409);
    expect((await overlap.json()).error).toContain("overlaps");

    const crossing = await addPeriod(
      post("/api/bookings/periods", { ...lunch, name: "Late", opensAt: "20:00", lastBookingAt: "22:00", closesAt: "01:00" }),
    );
    expect(crossing.status).toBe(400);
    expect(await periods()).toHaveLength(1);
  });

  it("edits a period, and a malformed or unknown id is a 404", async () => {
    await addPeriod(post("/api/bookings/periods", lunch));
    const [period] = await periods();

    const saved = await savePeriod(
      post(`/api/bookings/periods/${period.id}`, { ...lunch, name: "Long lunch", closesAt: "16:00" }),
      periodParams(period.id),
    );

    expect(saved.status).toBe(303);
    expect((await periods())[0]).toMatchObject({ name: "Long lunch", closesAt: "16:00:00" });
    for (const id of ["not-a-uuid", crypto.randomUUID()]) {
      expect(
        await statusOf(() => savePeriod(post(`/api/bookings/periods/${id}`, lunch), periodParams(id))),
      ).toBe(404);
    }
  });
});
