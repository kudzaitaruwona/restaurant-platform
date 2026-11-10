import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, notifications, restaurants } from "@/db/schema";
import { confirmBooking } from "@/lib/bookings";
import { metaSender, type SenderChoice, type SendResult, type WhatsAppSender } from "@/lib/whatsapp/sender";
import type { TemplateMessage } from "@/lib/whatsapp/templates";
import { aBooking, bookableRestaurant } from "../../../test/integration/bookings";
import { openOwnerDatabase, openSystemDatabase, testDatabaseSettings } from "../../../test/integration/database";
import { sendDueNotifications } from "./notifications";

/**
 * Spec 05's outbox, the sending half (#44), run as the scheduled job runs it: as
 * app_system, against real rows. Claim, then send: one short transaction moves
 * due rows from pending to sending (FOR UPDATE SKIP LOCKED) and commits; each
 * claimed row is then re-checked, sent, and marked sent with Meta's id.
 *
 * Like the other job tests this picks its own "now", in years no other file
 * uses (1994 to 1997), because the job looks across every restaurant: a run
 * here sends every row due by then, and only this file queues rows that early.
 * The test database outlives a run, so an interrupted run can leave rows behind:
 * each test looks only at what was sent for its own bookings.
 */
const owner = openOwnerDatabase();
const system = openSystemDatabase();
beforeAll(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseSettings().connectionString);
});
afterAll(async () => {
  await Promise.all([owner.pool.end(), system.pool.end()]);
  vi.unstubAllEnvs();
});

const GUEST_PHONE = "+263779876543";

/** A sender that records what it was asked to send and accepts it, as Meta would. */
/** `answer` may refuse a message, or do something mid-send; by default every message is accepted. */
function recordingSender(answer?: (message: TemplateMessage) => Promise<SendResult | void> | SendResult | void) {
  const sent: TemplateMessage[] = [];
  const sender: WhatsAppSender = {
    async send(message) {
      sent.push(message);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return (await answer?.(message)) ?? { ok: true, providerMessageId: `wamid.${message.manageToken}` };
    },
  };
  return { sent, choice: { kind: "meta", sender } satisfies SenderChoice };
}

/** The manage tokens sent, in order, among the given bookings only. */
const sentAmong = (sent: TemplateMessage[], ...ours: { manageToken: string }[]) => {
  const tokens = new Set(ours.map(({ manageToken }) => manageToken));
  return sent.map(({ manageToken }) => manageToken).filter((token) => tokens.has(token));
};

type Status = typeof bookings.$inferSelect["status"];

/** A booking with a phone and its booking_confirmed row, queued at `queuedAt`. */
async function queued(
  queuedAt: string,
  {
    restaurant,
    startsAt = "2030-01-01T17:00:00Z",
    status = "confirmed",
    phone = GUEST_PHONE,
    optIn = true,
    table = 0,
  }: {
    restaurant?: { restaurantId: string; tableIds: string[] };
    startsAt?: string;
    status?: Status;
    phone?: string | null;
    optIn?: boolean;
    table?: number;
  } = {},
) {
  const { restaurantId, tableIds } = restaurant ?? (await bookableRestaurant(owner.db));
  const start = new Date(startsAt);
  const [booking] = await owner.db
    .insert(bookings)
    .values({
      ...aBooking(restaurantId, tableIds[table], startsAt, new Date(start.getTime() + 2 * 3_600_000).toISOString()),
      guestName: "Tariro Moyo",
      guestPhone: phone,
      whatsappOptIn: optIn,
      partySize: 4,
      status,
    })
    .returning({ id: bookings.id, manageToken: bookings.manageToken });
  const [notification] = await owner.db
    .insert(notifications)
    .values({ restaurantId, bookingId: booking.id, kind: "booking_confirmed", scheduledFor: new Date(queuedAt) })
    .returning({ id: notifications.id });
  return { restaurantId, bookingId: booking.id, manageToken: booking.manageToken, id: notification.id };
}

const row = async (id: string) => {
  const [found] = await owner.db.select().from(notifications).where(eq(notifications.id, id));
  return found;
};

describe("the notification task", () => {
  it("claims a due booking_confirmed, sends it, and marks it sent with Meta's id", async () => {
    const { id, manageToken, restaurantId } = await queued("1994-03-01T10:00:00Z");
    const { sent, choice } = recordingSender();
    const before = Date.now();

    expect(await sendDueNotifications(system.db, new Date("1994-03-01T10:05:00Z"), choice)).toBeGreaterThanOrEqual(1);

    expect(sent.filter((message) => message.manageToken === manageToken)).toEqual([
      {
        to: GUEST_PHONE,
        template: "booking_confirmed",
        language: "en",
        // 17:00 UTC on 1 Jan 2030 is 19:00 in Harare.
        body: ["Tariro Moyo", `Restaurant ${restaurantId}`, "4", "Tue 1 Jan", "19:00", "+263771234567"],
        manageToken,
      },
    ]);
    const after = await row(id);
    expect(after).toMatchObject({
      status: "sent",
      providerMessageId: `wamid.${manageToken}`,
      attempts: 1,
      lastError: null,
    });
    expect(after.claimedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("writes the date and time on the restaurant's own clock", async () => {
    const restaurant = await bookableRestaurant(owner.db, { timezone: "America/New_York" });
    // 02:30 UTC on 3 May is 22:30 on 2 May in New York.
    const { manageToken } = await queued("1994-04-01T10:00:00Z", { restaurant, startsAt: "2030-05-03T02:30:00Z" });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1994-04-01T10:00:00Z"), choice);

    expect(sent.find((message) => message.manageToken === manageToken)?.body.slice(3, 5)).toEqual(["Thu 2 May", "22:30"]);
  });

  it("leaves a row that isn't due yet, and doesn't send a sent one again", async () => {
    const later = await queued("1994-05-02T10:00:00Z");
    const done = await queued("1994-05-01T09:00:00Z");
    const first = recordingSender();
    await sendDueNotifications(system.db, new Date("1994-05-01T10:00:00Z"), first.choice);
    expect(first.sent.map((message) => message.manageToken)).toContain(done.manageToken);
    expect(first.sent.map((message) => message.manageToken)).not.toContain(later.manageToken);
    expect((await row(later.id)).status).toBe("pending");

    const second = recordingSender();
    await sendDueNotifications(system.db, new Date("1994-05-02T10:00:00Z"), second.choice);
    expect(sentAmong(second.sent, later, done)).toEqual([later.manageToken]);
    expect((await row(done.id)).attempts).toBe(1);
  });

  /** `n` due bookings in one restaurant, each with a number of its own (0024 limits one number's bookings). */
  async function manyQueued(n: number, queuedAt: string) {
    const restaurant = await bookableRestaurant(owner.db, {
      tables: Array.from({ length: 4 }, () => ({ capacity: 4 })),
    });
    return Promise.all(
      Array.from({ length: n }, (_, i) =>
        queued(queuedAt, {
          restaurant,
          table: i % 4,
          phone: `+2637710${String(i).padStart(5, "0")}`,
          startsAt: new Date(Date.UTC(2030, 1, 1) + Math.floor(i / 4) * 3 * 3_600_000).toISOString(),
        }),
      ),
    );
  }

  it("two runs started at the same moment send every due row exactly once", async () => {
    const rows = await manyQueued(60, "1995-01-01T10:00:00Z");
    const a = recordingSender();
    const b = recordingSender();
    const now = new Date("1995-01-01T10:00:00Z");

    await Promise.all([
      sendDueNotifications(system.db, now, a.choice),
      sendDueNotifications(system.db, now, b.choice),
    ]);

    const tokens = sentAmong([...a.sent, ...b.sent], ...rows);
    expect(tokens).toHaveLength(60);
    expect(new Set(tokens).size).toBe(60);
    for (const { id, manageToken } of rows) {
      expect(await row(id)).toMatchObject({ status: "sent", attempts: 1, providerMessageId: `wamid.${manageToken}` });
    }
  });

  it("a run that starts while another is still sending claims only rows the first hasn't", async () => {
    const rows = await manyQueued(30, "1995-02-01T10:00:00Z");
    const now = new Date("1995-02-01T10:00:00Z");
    const second = recordingSender();
    let started = false;
    // The second run starts, and finishes, while the first is on its first send:
    // the first's batch is claimed (sending) and not yet sent.
    const first = recordingSender(async () => {
      if (!started) {
        started = true;
        await sendDueNotifications(system.db, now, second.choice);
      }
    });

    await sendDueNotifications(system.db, now, first.choice);

    const byFirst = sentAmong(first.sent, ...rows);
    const bySecond = sentAmong(second.sent, ...rows);
    expect(byFirst.length).toBeGreaterThan(0);
    expect(bySecond.length).toBeGreaterThan(0);
    expect(byFirst.filter((token) => bySecond.includes(token))).toEqual([]);
    expect(new Set([...byFirst, ...bySecond]).size).toBe(30);
    for (const { id } of rows) expect(await row(id)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it.each(["cancelled", "no_show", "seated", "completed"] as const)(
    "marks booking_confirmed cancelled without sending when the booking is %s by the time it is sent",
    async (status) => {
      const { id, manageToken } = await queued("1996-01-01T10:00:00Z", { status });
      const { sent, choice } = recordingSender();

      await sendDueNotifications(system.db, new Date("1996-01-01T10:00:00Z"), choice);

      expect(sent.map((message) => message.manageToken)).not.toContain(manageToken);
      expect(await row(id)).toMatchObject({ status: "cancelled", providerMessageId: null });
    },
  );

  it("re-checks each booking just before its own send, not only at the claim", async () => {
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    const first = await queued("1996-02-01T09:00:00Z", { restaurant, table: 0 });
    const second = await queued("1996-02-01T10:00:00Z", { restaurant, table: 1 });
    // The guest cancels the second booking while the first message is going out.
    const { sent, choice } = recordingSender(async (message) => {
      if (message.manageToken === first.manageToken) {
        await owner.db
          .update(bookings)
          .set({ status: "cancelled", cancelledBy: "guest", cancelledAt: new Date() })
          .where(eq(bookings.id, second.bookingId));
      }
      return { ok: true, providerMessageId: `wamid.${message.manageToken}` };
    });

    await sendDueNotifications(system.db, new Date("1996-02-01T10:00:00Z"), choice);

    expect(sentAmong(sent, first, second)).toEqual([first.manageToken]);
    expect(await row(second.id)).toMatchObject({ status: "cancelled" });
  });

  it("marks it cancelled without sending when the number has gone or the opt-in is off", async () => {
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    const purged = await queued("1996-03-01T10:00:00Z", { restaurant, table: 0, phone: null });
    const optedOut = await queued("1996-03-01T10:00:00Z", { restaurant, table: 1, optIn: false });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1996-03-01T10:00:00Z"), choice);

    expect(sentAmong(sent, purged, optedOut)).toEqual([]);
    expect(await row(purged.id)).toMatchObject({ status: "cancelled" });
    expect(await row(optedOut.id)).toMatchObject({ status: "cancelled" });
  });

  it("marks a send Meta refused failed, with its error, and never sent", async () => {
    const { id } = await queued("1996-04-01T10:00:00Z");
    const { choice } = recordingSender(() => ({ ok: false, error: "Meta 400 (131030): Recipient phone number not in allowed list" }));

    await sendDueNotifications(system.db, new Date("1996-04-01T10:00:00Z"), choice);

    expect(await row(id)).toMatchObject({
      status: "failed",
      providerMessageId: null,
      attempts: 1,
      lastError: "Meta 400 (131030): Recipient phone number not in allowed list",
    });
  });

  it("marks it failed without sending when the restaurant has no contact phone for {{6}}", async () => {
    const restaurant = await bookableRestaurant(owner.db);
    await owner.db.update(restaurants).set({ contactPhone: null }).where(eq(restaurants.id, restaurant.restaurantId));
    const queuedRow = await queued("1996-05-01T10:00:00Z", { restaurant });
    const { id } = queuedRow;
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1996-05-01T10:00:00Z"), choice);

    expect(sentAmong(sent, queuedRow)).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "failed", lastError: expect.stringMatching(/contact phone/) });
  });

  it("stops sending when its time budget runs out, and puts the rows it claimed but didn't send back to pending", async () => {
    const rows = await manyQueued(5, "1996-07-01T10:00:00Z");
    const now = new Date("1996-07-01T10:00:00Z");
    // Meta is slow: every send takes three times the run's whole budget.
    const slow = recordingSender(() => new Promise<void>((resolve) => setTimeout(resolve, 300)));
    const started = Date.now();

    await sendDueNotifications(system.db, now, slow.choice, { budgetMs: 100 });

    // One send past the deadline, then it stops: not five sends' worth.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(slow.sent.length).toBe(1);
    const after = await Promise.all(rows.map(({ id }) => row(id)));
    expect(after.filter(({ status }) => status === "sending")).toEqual([]);
    const released = after.filter(({ status }) => status === "pending");
    expect(released.length).toBeGreaterThanOrEqual(rows.length - 1);
    // Released unsent: no claim time, and the claim's attempt given back.
    for (const found of released) expect(found).toMatchObject({ claimedAt: null, attempts: 0 });

    // The next run sends them, each on its first attempt.
    const next = recordingSender();
    await sendDueNotifications(system.db, now, next.choice);
    for (const found of released) expect(await row(found.id)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("claims nothing once its time budget has run out", async () => {
    const { id } = await queued("1996-08-01T10:00:00Z");
    const { sent, choice } = recordingSender();

    expect(await sendDueNotifications(system.db, new Date("1996-08-01T10:00:00Z"), choice, { budgetMs: 0 })).toBe(0);

    expect(sent).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "pending", claimedAt: null, attempts: 0 });
  });

  it("holds due rows as pending when WhatsApp isn't configured in production, and sends them once it is", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id, manageToken } = await queued("1996-06-01T10:00:00Z");
    const now = new Date("1996-06-01T10:00:00Z");

    expect(
      await sendDueNotifications(system.db, now, { kind: "hold", missing: ["WHATSAPP_ACCESS_TOKEN"] }),
    ).toBe(0);
    expect(await row(id)).toMatchObject({ status: "pending", claimedAt: null, attempts: 0 });
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toMatch(/holding/i);
    expect(logged).toContain("WHATSAPP_ACCESS_TOKEN");
    log.mockRestore();

    const { sent, choice } = recordingSender();
    await sendDueNotifications(system.db, now, choice);
    expect(sentAmong(sent, { manageToken })).toEqual([manageToken]);
    expect((await row(id)).status).toBe("sent");
  });
});

describe("confirming a booking, end to end, against a stand-in for Meta's Graph API", () => {
  let server: Server;
  let baseUrl: string;
  const received: { url?: string; authorization?: string; body: { to: string; template: { name: string; components: { parameters: { text: string }[] }[] } } }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        received.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(raw) });
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.${received.length}` }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("sends booking_confirmed through the Cloud API on the job's next run, and records Meta's id", async () => {
    const { restaurantId } = await bookableRestaurant(owner.db);
    // 08:00 on Tuesday 4 March 1997 in Harare; the guest books 19:30 on Wednesday.
    const confirmedAt = new Date("1997-03-04T06:00:00Z");
    const outcome = await confirmBooking(
      { restaurantId },
      { party: 2, date: "1997-03-05", time: "19:30", name: "Tariro", phone: GUEST_PHONE, note: null, whatsappOptIn: true },
      confirmedAt,
    );
    expect(outcome.outcome).toBe("confirmed");

    const sender = metaSender({ phoneNumberId: "106540352242922", accessToken: "test-token", baseUrl });
    // The job runs every 5 minutes: its next run is at most 5 minutes later.
    await sendDueNotifications(system.db, new Date(confirmedAt.getTime() + 5 * 60_000), { kind: "meta", sender });

    const mine = received.filter(({ body }) => body.to === GUEST_PHONE && body.template.components[0].parameters[1].text === `Restaurant ${restaurantId}`);
    expect(mine).toHaveLength(1);
    expect(mine[0].url).toBe("/v23.0/106540352242922/messages");
    expect(mine[0].authorization).toBe("Bearer test-token");
    expect(mine[0].body.template.name).toBe("booking_confirmed");
    expect(mine[0].body.template.components[0].parameters.map(({ text }) => text)).toEqual([
      "Tariro",
      `Restaurant ${restaurantId}`,
      "2",
      "Wed 5 Mar",
      "19:30",
      "+263771234567",
    ]);
    const { rows } = await owner.db.execute<{ status: string; provider_message_id: string }>(
      sql`select status, provider_message_id from notifications where restaurant_id = ${restaurantId}`,
    );
    expect(rows).toEqual([{ status: "sent", provider_message_id: expect.stringMatching(/^wamid\./) }]);
  });
});
