import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  devIdentities,
  devPlatformAdmin,
  devRestaurants,
} from "@/lib/tenant/dev-identities";
import { bookings, onboardingChecklist, restaurants, staff, staffInvites } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, testDatabaseSettings } from "../../../test/integration/database";
import { statusOf } from "../../../test/integration/http";
import { AdminConsole } from "./admin-console";

const session = vi.hoisted(() => ({ identity: "" }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => ({ name, value: session.identity }),
  }),
}));

// The form's useRouter needs the app router, which a static render doesn't mount.
vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
}));

beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
  vi.stubEnv("DEV_AUTH_BYPASS", "1");
});
afterAll(() => vi.unstubAllEnvs());

/** One restaurant's card, from its way in to the next restaurant's. */
const cardIn = (html: string, restaurantId: string) => {
  const start = html.indexOf(`${restaurantId}/enter`);
  const next = html.indexOf("/enter\"", start + restaurantId.length + 7);
  return html.slice(start, next < 0 ? undefined : next);
};

const render = async () => {
  session.identity = devPlatformAdmin.key;
  return renderToStaticMarkup(await AdminConsole());
};

describe("the admin screen", () => {
  it("lists every restaurant, across tenants", async () => {
    const html = await render();
    for (const { name, slug } of devRestaurants) {
      expect(html).toContain(name);
      expect(html).toContain(slug);
    }
  });

  it("offers to create a restaurant, with the timezone filled in", async () => {
    const html = await render();
    expect(html).toContain('name="slug"');
    expect(html).toContain('value="Africa/Harare"');
    expect(html).toContain('value="zig_primary"');
  });

  it("offers to enter every restaurant, as a plain post that can redirect", async () => {
    const html = await render();
    for (const { id } of devRestaurants) {
      expect(html).toContain(`action="/api/admin/restaurants/${id}/enter"`);
    }
    expect(html).toContain("Enter restaurant");
  });

  it("shows each restaurant's onboarding checklist, all seven items", async () => {
    const html = await render();
    for (const label of [
      "Menu entered",
      "Photos",
      "Exchange rate set",
      "Tables added",
      "QR codes printed",
      "Booking hours set",
      "Booking enabled",
    ]) {
      expect(html.split(label).length - 1).toBeGreaterThanOrEqual(devRestaurants.length);
    }
  });

  it("lets the admin tick QR codes printed, as an unticked box to start", async () => {
    const html = await render();
    expect(html).toContain("Tick as printed");
    expect(html).toContain('<input type="hidden" name="printed" value="true"/>');
  });

  it("shows when it was ticked in the restaurant's timezone, and offers to untick", async () => {
    const owner = openOwnerDatabase();
    const slug = `tz-${crypto.randomUUID()}`;
    const [restaurant] = await owner.db
      .insert(restaurants)
      .values({ name: "Midnight Grill", slug, menuToken: slug, currencyMode: "both", timezone: "Pacific/Auckland" })
      .returning();
    try {
      // 23:30 UTC on 1 March is already 2 March in Auckland (UTC+13).
      await owner.db.insert(onboardingChecklist).values({
        restaurantId: restaurant.id,
        qrCodesPrintedAt: new Date("2026-03-01T23:30:00Z"),
        qrCodesPrintedBy: devPlatformAdmin.platformAdminId,
      });

      const html = await render();

      const start = html.indexOf(`${restaurant.id}/enter`);
      const row = html.slice(start, html.indexOf("</ul>", start));
      expect(row).toContain("2 Mar 2026");
      expect(row).not.toContain("1 Mar 2026");
      expect(row).toContain("Untick");
      expect(row).toContain('<input type="hidden" name="printed" value="false"/>');
    } finally {
      await owner.db.delete(restaurants).where(eq(restaurants.id, restaurant.id));
      await owner.pool.end();
    }
  });

  it("says how each checklist item is decided, in plain words under it", async () => {
    const html = await render();
    for (const rule of [
      "Done when at least one menu item is live.",
      "Done when a live item has a photo.",
      "Done once any rate is saved. It is set on the Menu page.",
      "Done when a table is live.",
      "Tick once the codes are printed and on the tables.",
      "Done when there is a service period.",
      "Done when online booking is on. It needs a bookable table, a service period and a contact phone.",
    ]) {
      expect(html).toContain(rule);
    }
  });

  it("creates in a two-step sheet: the restaurant, then its owner, closed until asked", async () => {
    const html = await render();
    expect(html).toMatch(/<dialog aria-labelledby="new-restaurant-title"/);
    expect(html).not.toMatch(/<dialog[^>]*\sopen(=""|\s|>)/);
    expect(html).toContain('<form id="new-restaurant-form"');
    expect(html).toContain('<form id="new-owner-form" inert=""');
    expect(html).toContain('name="displayName"');
    // The owner step's route is only known once the restaurant exists.
    expect(html).not.toMatch(/action="\/api\/admin\/restaurants\/[^"]*\/owner"[^>]*id="new-owner-form"/);
  });

  it("gives a restaurant with an owner a ready-to-send sign-in message, escaped", async () => {
    // Left in place, like the other restaurants these tests make: its owner is
    // its last one, which the database won't let go.
    const owner = openOwnerDatabase();
    const slug = `msg-${crypto.randomUUID()}`;
    const name = `<img src=x onerror=alert(1)> "Tom & Jerry's"`;
    try {
      const [restaurant] = await owner.db
        .insert(restaurants)
        .values({ name, slug, menuToken: slug, currencyMode: "both" })
        .returning();
      await owner.db.insert(staff).values({
        restaurantId: restaurant.id,
        email: `${slug}@example.test`,
        displayName: "Tom",
        role: "owner",
      });

      const html = await render();

      const item = cardIn(html, restaurant.id);
      const login = new URL("/login", getEnv().NEXT_PUBLIC_APP_URL).toString();
      expect(item).toContain(
        `Hi, &lt;img src=x onerror=alert(1)&gt; &quot;Tom &amp; Jerry&#x27;s&quot; is ready for you. Sign in at ${login}`,
      );
      expect(item).toContain("Copy message for WhatsApp");
      expect(html).not.toContain("<img src=x");
      expect(item).not.toContain(`${restaurant.id}/owner`);
    } finally {
      await owner.pool.end();
    }
  });

  describe("the owner card: Invited or Joined (S-42)", () => {
    const owner = openOwnerDatabase();
    afterAll(() => owner.pool.end());

    /** A restaurant with an owner, left in place: its last owner can't go. */
    async function withOwner(state: {
      joined?: Date;
      invite?: { sentAt: Date; delivered: boolean };
    }) {
      const slug = `card-${crypto.randomUUID()}`;
      const [restaurant] = await owner.db
        .insert(restaurants)
        .values({ name: "Card Grill", slug, menuToken: slug, currencyMode: "both" })
        .returning();
      const staffId = crypto.randomUUID();
      await owner.db.insert(staff).values({
        id: staffId,
        restaurantId: restaurant.id,
        email: `${slug}@example.test`,
        displayName: "Rudo Chari",
        role: "owner",
        firstSignedInAt: state.joined,
      });
      if (state.invite) {
        const [row] = await owner.db
          .insert(staffInvites)
          .values({ restaurantId: restaurant.id, staffId, delivered: state.invite.delivered })
          .returning();
        await owner.db
          .update(staffInvites)
          .set({ sentAt: state.invite.sentAt })
          .where(eq(staffInvites.id, row.id));
      }
      return { restaurantId: restaurant.id, staffId, email: `${slug}@example.test` };
    }

    it("names the owner and when they were invited, and offers to send it again", async () => {
      const { restaurantId, staffId, email } = await withOwner({
        invite: { sentAt: new Date("2026-11-12T12:05:00Z"), delivered: true },
      });

      const card = cardIn(await render(), restaurantId);

      expect(card).toContain("Rudo Chari");
      expect(card).toContain(email);
      expect(card).toContain("Invited 12 Nov, 14:05");
      expect(card).toContain("Send invite again");
      expect(card).toContain(`<input type="hidden" name="staffId" value="${staffId}"/>`);
    });

    it("says when the invite didn't go", async () => {
      const { restaurantId } = await withOwner({
        invite: { sentAt: new Date(), delivered: false },
      });
      expect(cardIn(await render(), restaurantId)).toContain("Invite email didn&#x27;t go");
    });

    it("says Joined, and offers no invite, once the owner has signed in", async () => {
      const { restaurantId } = await withOwner({ joined: new Date("2026-11-12T12:05:00Z") });

      const card = cardIn(await render(), restaurantId);

      expect(card).toContain("Joined 12 Nov");
      expect(card).not.toContain("Send invite");
      expect(card).not.toContain(`${restaurantId}/invite`);
    });

    it("tells the admin the owner is emailed when they create one", async () => {
      expect(await render()).toContain("We email them an invite");
    });
  });

  it("doesn't offer a first owner to a restaurant that has one", async () => {
    const html = await render();
    expect(html).not.toContain(`${devRestaurants[0].id}/owner`);
  });

  it.each(devIdentities.map((identity) => [identity.key] as const))(
    "refuses restaurant staff with forbidden(), before any data renders: %s",
    async (key) => {
      session.identity = key;
      expect(await statusOf(() => AdminConsole())).toBe(403);
    },
  );

  it("refuses no identity with unauthorized(), before any data renders", async () => {
    session.identity = "nobody";
    expect(await statusOf(() => AdminConsole())).toBe(401);
  });
});

describe("the booking metrics, per restaurant", () => {
  const owner = openOwnerDatabase();
  afterAll(() => owner.pool.end());

  async function restaurantWith(rows: Partial<typeof bookings.$inferInsert>[]) {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db, {
      tables: rows.map(() => ({ capacity: 2 })),
    });
    await owner.db.insert(bookings).values(
      rows.map((row, index) => ({
        ...aBooking(restaurantId, tableIds[index], "2027-01-10T16:00:00Z", "2027-01-10T17:45:00Z"),
        ...row,
      })),
    );
    return `Restaurant ${restaurantId}`;
  }

  /** The text of the list item that names the restaurant. */
  const itemOf = (html: string, name: string) => {
    const item = html.split("<li").find((part) => part.includes(name))!;
    return item.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ");
  };

  it("shows each restaurant its own numbers, from the same count the owner sees", async () => {
    // Made at 05:00 Harare time, before dinner opens: while staff weren't answering.
    const early = { createdAt: new Date("2026-11-05T03:00:00Z") };
    const busy = await restaurantWith([
      { ...early, status: "no_show" },
      { ...early, status: "completed" },
      { ...early, status: "completed", source: "staff" },
      { status: "completed", source: "staff" },
    ]);
    const quiet = await restaurantWith([{ status: "completed" }]);

    const html = await render();

    expect(itemOf(html, busy)).toContain("Booked online 50% 2 online, 2 added by staff");
    expect(itemOf(html, busy)).toContain("Booked while staff weren't answering 2");
    expect(itemOf(html, busy)).toContain("No-show rate 25% 1 of 4 finished bookings");
    expect(itemOf(html, quiet)).toContain("Booked online 100% 1 online, 0 added by staff");
    expect(itemOf(html, quiet)).toContain("No-show rate 0% 0 of 1 finished bookings");
  });

  it("shows a restaurant with no bookings as having none", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    const empty = `Restaurant ${restaurantId}`;

    expect(itemOf(await render(), empty)).toContain("No bookings yet");
  });
});

describe("the admin page", () => {
  const renderPage = async (bypass: string) => {
    vi.stubEnv("DEV_AUTH_BYPASS", bypass);
    vi.resetModules(); // fresh env cache
    const [{ renderToString }, { default: AdminPage }] = await Promise.all([
      import("react-dom/server"),
      import("./page"),
    ]);
    return renderToString(<AdminPage />);
  };

  it("offers sign-out on a real session", async () => {
    const html = await renderPage("");
    expect(html).toContain("Sign out");
    expect(html).not.toContain("Dev: act as");
  });

  it("offers the dev switcher instead under the bypass", async () => {
    const html = await renderPage("1");
    expect(html).toContain("Dev: act as");
    expect(html).not.toContain("Sign out");
  });
});
