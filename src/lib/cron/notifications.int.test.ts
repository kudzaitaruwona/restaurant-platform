import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bookings, notifications, restaurants } from "@/db/schema";
import { cancelBooking as staffCancel } from "@/lib/booking-day";
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
      return (await answer?.(message)) ?? { ok: true, providerMessageId: `wamid.${message.manageToken ?? message.body[1]}` };
    },
  };
  return { sent, choice: { kind: "meta", sender } satisfies SenderChoice };
}

/** The manage tokens sent, in order, among the given bookings only. */
const sentAmong = (sent: TemplateMessage[], ...ours: { manageToken: string }[]) => {
  const tokens = new Set(ours.map(({ manageToken }) => manageToken));
  return sent.map(({ manageToken }) => manageToken).filter((token): token is string => token !== undefined && tokens.has(token));
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
    kind = "booking_confirmed",
    cancelledBy,
  }: {
    restaurant?: { restaurantId: string; tableIds: string[] };
    startsAt?: string;
    status?: Status;
    phone?: string | null;
    optIn?: boolean;
    table?: number;
    kind?: typeof notifications.$inferInsert["kind"];
    cancelledBy?: "guest" | "staff";
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
      ...(cancelledBy ? { cancelledBy, cancelledAt: new Date(queuedAt) } : {}),
    })
    .returning({ id: bookings.id, manageToken: bookings.manageToken });
  const [notification] = await owner.db
    .insert(notifications)
    .values({ restaurantId, bookingId: booking.id, kind, scheduledFor: new Date(queuedAt) })
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
      return { ok: true, providerMessageId: `wamid.${message.manageToken ?? message.body[1]}` };
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

  it("marks a send Meta refused for good failed at once, with its error, and never sent", async () => {
    const { id } = await queued("1996-04-01T10:00:00Z");
    const { choice } = recordingSender(() => ({
      ok: false,
      error: "Meta 400 (131030): Recipient phone number not in allowed list",
      retryable: false,
    }));

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
    // Meta is slow: every send takes three times the run's whole budget. The numbers are
    // large so a slow CI runner's claim transaction still finishes inside the budget.
    const slow = recordingSender(() => new Promise<void>((resolve) => setTimeout(resolve, 3_000)));
    const started = Date.now();

    await sendDueNotifications(system.db, now, slow.choice, { budgetMs: 1_000 });

    // One send past the deadline, then it stops: not five sends' worth (five would take 15 s).
    expect(Date.now() - started).toBeLessThan(5_000);
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

describe("retries and recovery (#47)", () => {
  const at = (iso: string, minutes = 0) => new Date(new Date(iso).getTime() + minutes * 60_000);
  const busy = (): SendResult => ({ ok: false, error: "Meta 503", retryable: true });

  it("retries a send that may work later up to 3 attempts, 5 then 10 minutes apart, then marks it failed", async () => {
    const start = "1997-05-01T10:00:00Z";
    const { id, manageToken } = await queued(start);
    const { sent, choice } = recordingSender(busy);
    const mine = () => sentAmong(sent, { manageToken });

    await sendDueNotifications(system.db, at(start), choice);
    expect(mine()).toHaveLength(1);
    expect(await row(id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "Meta 503",
      claimedAt: null,
      scheduledFor: at(start, 5),
    });

    // Not before its backoff.
    await sendDueNotifications(system.db, at(start, 4), choice);
    expect(mine()).toHaveLength(1);

    await sendDueNotifications(system.db, at(start, 5), choice);
    expect(mine()).toHaveLength(2);
    expect(await row(id)).toMatchObject({ status: "pending", attempts: 2, scheduledFor: at(start, 15) });

    await sendDueNotifications(system.db, at(start, 14), choice);
    expect(mine()).toHaveLength(2);
    await sendDueNotifications(system.db, at(start, 15), choice);
    expect(mine()).toHaveLength(3);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 3, lastError: "Meta 503", providerMessageId: null });

    // Failed is final: no fourth attempt.
    await sendDueNotifications(system.db, at(start, 60), choice);
    expect(mine()).toHaveLength(3);
  });

  it("marks a retried send that goes through sent, keeping the attempts it took", async () => {
    const start = "1997-05-02T10:00:00Z";
    const { id, manageToken } = await queued(start);
    let tried = false;
    // Only this row's first send fails: the run may send other rows due by then.
    const { choice } = recordingSender((message) => {
      if (message.manageToken !== manageToken || tried) return;
      tried = true;
      return busy();
    });

    await sendDueNotifications(system.db, at(start), choice);
    await sendDueNotifications(system.db, at(start, 5), choice);

    expect(await row(id)).toMatchObject({ status: "sent", attempts: 2, providerMessageId: `wamid.${manageToken}` });
  });

  it("retries a sender that throws, as it can't say whether the message went", async () => {
    const start = "1997-05-03T10:00:00Z";
    const { id } = await queued(start);
    const { choice } = recordingSender(() => {
      throw new TypeError("boom");
    });

    await sendDueNotifications(system.db, at(start), choice);

    expect(await row(id)).toMatchObject({ status: "pending", attempts: 1, lastError: "Sender failed: TypeError" });
  });

  /** Puts a row in sending as a run that claimed it `minutesAgo` minutes ago and then died would leave it. */
  async function stuck(id: string, minutesAgo: number, attempts = 1) {
    await owner.db.execute(
      sql`update notifications set status = 'sending', attempts = ${attempts},
          claimed_at = now() - make_interval(mins => ${minutesAgo}) where id = ${id}`,
    );
  }

  it("returns a row stuck in sending for more than 10 minutes to pending, and the same run sends it again", async () => {
    const start = "1997-06-01T10:00:00Z";
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    const crashed = await queued(start, { restaurant, table: 0 });
    const recent = await queued(start, { restaurant, table: 1 });
    await stuck(crashed.id, 11);
    await stuck(recent.id, 9);
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, at(start), choice);

    // At least once: the crashed run may have got it to Meta, and the guest may get it twice.
    expect(sentAmong(sent, crashed, recent)).toEqual([crashed.manageToken]);
    expect(await row(crashed.id)).toMatchObject({ status: "sent", attempts: 2 });
    // Under 10 minutes it may still be in a live run's hands: left alone.
    expect(await row(recent.id)).toMatchObject({ status: "sending", attempts: 1 });
  });

  it("returns a stuck row to pending even while WhatsApp is held", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { id } = await queued("1997-06-02T10:00:00Z");
    await stuck(id, 11);

    await sendDueNotifications(system.db, at("1997-06-02T10:00:00Z"), { kind: "hold", missing: ["WHATSAPP_ACCESS_TOKEN"] });

    expect(await row(id)).toMatchObject({ status: "pending", claimedAt: null, attempts: 1 });
    vi.restoreAllMocks();
  });

  it("marks a stuck row failed instead when it has used its 3 attempts", async () => {
    const { id, manageToken } = await queued("1997-06-03T10:00:00Z");
    await stuck(id, 11, 3);
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, at("1997-06-03T10:00:00Z"), choice);

    expect(sentAmong(sent, { manageToken })).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "failed", attempts: 3, lastError: expect.stringMatching(/sending/) });
  });

  it("a run whose rows were recovered and claimed again by another doesn't send or write them over", async () => {
    const start = "1997-07-01T10:00:00Z";
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    const x = await queued(at(start, -1).toISOString(), { restaurant, table: 0 });
    const y = await queued(start, { restaurant, table: 1 });
    const now = at(start);

    // B: a later run. Its send of x waits until the test lets it go.
    let letBGo!: () => void;
    const bMayFinish = new Promise<void>((resolve) => (letBGo = resolve));
    let bSendingX!: () => void;
    const bIsSendingX = new Promise<void>((resolve) => (bSendingX = resolve));
    const b = recordingSender(async (message) => {
      if (message.manageToken === x.manageToken) {
        bSendingX();
        await bMayFinish;
      }
      return { ok: true, providerMessageId: `wamid.B.${message.manageToken}` };
    });
    let bRun: Promise<number> | undefined;

    // A: claims x and y, and stalls on x for over 10 minutes (made to look so by
    // ageing its claim). Meanwhile B recovers both, claims them, and is sending x.
    const a = recordingSender(async (message) => {
      if (message.manageToken === x.manageToken && !bRun) {
        await owner.db.execute(
          sql`update notifications set claimed_at = claimed_at - interval '11 minutes' where id in (${x.id}, ${y.id})`,
        );
        bRun = sendDueNotifications(system.db, now, b.choice);
        await bIsSendingX;
      }
      return { ok: true, providerMessageId: `wamid.A.${message.manageToken}` };
    });

    await sendDueNotifications(system.db, now, a.choice);
    letBGo();
    await bRun;

    // x went twice, the accepted at-least-once duplicate; y, which A hadn't started, once.
    expect(sentAmong(a.sent, x, y)).toEqual([x.manageToken]);
    expect(sentAmong(b.sent, x, y)).toEqual([x.manageToken, y.manageToken]);
    // A's late answer for x didn't overwrite B's claim: B's own send settled it.
    expect(await row(x.id)).toMatchObject({ status: "sent", attempts: 2, providerMessageId: `wamid.B.${x.manageToken}` });
    expect(await row(y.id)).toMatchObject({ status: "sent", attempts: 2, providerMessageId: `wamid.B.${y.manageToken}` });
  });

  it("a run out of time doesn't put back a row recovered from it that another run is sending", async () => {
    const start = "1997-07-02T10:00:00Z";
    const restaurant = await bookableRestaurant(owner.db, { tables: [{ capacity: 4 }, { capacity: 4 }] });
    const x = await queued(at(start, -1).toISOString(), { restaurant, table: 0 });
    const y = await queued(start, { restaurant, table: 1 });
    const now = at(start);

    let letBGo!: () => void;
    const bMayFinish = new Promise<void>((resolve) => (letBGo = resolve));
    let bSendingY!: () => void;
    const bIsSendingY = new Promise<void>((resolve) => (bSendingY = resolve));
    const b = recordingSender(async (message) => {
      if (message.manageToken === y.manageToken) {
        bSendingY();
        await bMayFinish;
      }
    });
    let bRun: Promise<number> | undefined;

    // A stalls on x past its budget, so it never starts y and releases it on the way
    // out; by then y was recovered and B is sending it.
    const a = recordingSender(async (message) => {
      if (message.manageToken === x.manageToken && !bRun) {
        await owner.db.execute(
          sql`update notifications set claimed_at = claimed_at - interval '11 minutes' where id in (${x.id}, ${y.id})`,
        );
        bRun = sendDueNotifications(system.db, now, b.choice);
        await bIsSendingY;
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
    });

    await sendDueNotifications(system.db, now, a.choice, { budgetMs: 1_000 });
    expect(sentAmong(a.sent, x, y)).toEqual([x.manageToken]);
    // Still B's: A's release left it alone.
    expect(await row(y.id)).toMatchObject({ status: "sending", attempts: 2 });
    letBGo();
    await bRun;

    expect(sentAmong(b.sent, x, y)).toEqual([x.manageToken, y.manageToken]);
    expect(await row(y.id)).toMatchObject({ status: "sent", attempts: 2, providerMessageId: `wamid.${y.manageToken}` });
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
      sql`select status, provider_message_id from notifications where restaurant_id = ${restaurantId} and kind = 'booking_confirmed'`,
    );
    expect(rows).toEqual([{ status: "sent", provider_message_id: expect.stringMatching(/^wamid\./) }]);
    // The reminder (#45) is queued beside it, for 16:30 on the day, and is not due yet.
    const { rows: reminders } = await owner.db.execute<{ status: string }>(
      sql`select status from notifications where restaurant_id = ${restaurantId} and kind = 'booking_reminder'`,
    );
    expect(reminders).toEqual([{ status: "pending" }]);
  });
});

/**
 * The booking reminder (#45), sent by the same task. Year 1993, before every other
 * test here: a run sends every row due by its "now", so these must be the only rows
 * that early, and the blocks above only queue rows from 1994.
 */
describe("the booking reminder", () => {
  /** A booking starting at `startsAt` with its reminder pending at starts_at - 3h. */
  async function withReminder(startsAt: string, status: Status = "confirmed") {
    const { restaurantId, tableIds } = await bookableRestaurant(owner.db);
    const start = new Date(startsAt);
    const [booking] = await owner.db
      .insert(bookings)
      .values({
        ...aBooking(restaurantId, tableIds[0], startsAt, new Date(start.getTime() + 2 * 3_600_000).toISOString()),
        guestName: "Tariro Moyo",
        guestPhone: GUEST_PHONE,
        partySize: 4,
        status,
      })
      .returning({ id: bookings.id, manageToken: bookings.manageToken });
    const [reminder] = await owner.db
      .insert(notifications)
      .values({
        restaurantId,
        bookingId: booking.id,
        kind: "booking_reminder",
        scheduledFor: new Date(start.getTime() - 3 * 3_600_000),
      })
      .returning({ id: notifications.id });
    return { restaurantId, ...booking, reminderId: reminder.id };
  }

  it("is not sent before starts_at - 3h, and is sent with its own template once that time comes", async () => {
    // 17:00 UTC is 19:00 in Harare.
    const { manageToken, reminderId, restaurantId } = await withReminder("1993-03-10T17:00:00Z");
    const early = recordingSender();

    await sendDueNotifications(system.db, new Date("1993-03-10T13:59:00Z"), early.choice);
    expect(sentAmong(early.sent, { manageToken })).toEqual([]);
    expect((await row(reminderId)).status).toBe("pending");

    const due = recordingSender();
    await sendDueNotifications(system.db, new Date("1993-03-10T14:00:00Z"), due.choice);
    expect(due.sent.filter((message) => message.manageToken === manageToken)).toEqual([
      {
        to: GUEST_PHONE,
        template: "booking_reminder",
        language: "en",
        body: ["Tariro Moyo", `Restaurant ${restaurantId}`, "Wed 10 Mar", "19:00", "4"],
        manageToken,
      },
    ]);
    expect(await row(reminderId)).toMatchObject({ status: "sent", providerMessageId: `wamid.${manageToken}` });
  });

  it("is marked cancelled without sending when the booking is no longer confirmed at send time", async () => {
    // The booking changed some way that didn't cancel the row.
    const { manageToken, reminderId } = await withReminder("1993-04-10T17:00:00Z", "seated");
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1993-04-10T15:00:00Z"), choice);

    expect(sentAmong(sent, { manageToken })).toEqual([]);
    expect((await row(reminderId)).status).toBe("cancelled");
  });

  it("is never sent for a booking cancelled before the reminder time", async () => {
    const { restaurantId, id, manageToken, reminderId } = await withReminder("1993-05-10T17:00:00Z");

    expect((await staffCancel({ restaurantId, staffId: crypto.randomUUID() }, id)).outcome).toBe("done");

    const { sent, choice } = recordingSender();
    // At the reminder time, an hour after it, and the day after: never.
    for (const at of ["1993-05-10T14:00:00Z", "1993-05-10T15:00:00Z", "1993-05-11T14:00:00Z"]) {
      await sendDueNotifications(system.db, new Date(at), choice);
    }
    expect(sentAmong(sent, { manageToken })).toEqual([]);
    expect((await row(reminderId)).status).toBe("cancelled");
  });
});

describe("booking_cancelled", () => {
  const cancelledRow = (queuedAt: string, options: Parameters<typeof queued>[1] = {}) =>
    queued(queuedAt, { status: "cancelled", kind: "booking_cancelled", cancelledBy: "guest", ...options });

  it("sends a cancelled booking its cancellation, with the guest's own wording when the guest cancelled", async () => {
    const { id, restaurantId } = await cancelledRow("1995-03-01T10:00:00Z");
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-01T10:05:00Z"), choice);

    expect(sent.filter((message) => message.body[1] === `Restaurant ${restaurantId}`)).toEqual([
      {
        to: GUEST_PHONE,
        template: "booking_cancelled",
        language: "en",
        body: ["Tariro Moyo", `Restaurant ${restaurantId}`, "Tue 1 Jan", "19:00", "We hope to see you another time."],
      },
    ]);
    expect(await row(id)).toMatchObject({ status: "sent", attempts: 1 });
  });

  it("gives the restaurant's contact line when staff cancelled", async () => {
    const { id, restaurantId } = await cancelledRow("1995-03-02T10:00:00Z", { cancelledBy: "staff" });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-02T10:05:00Z"), choice);

    expect(sent.find((message) => message.body[1] === `Restaurant ${restaurantId}`)?.body[4]).toBe(
      "If you have any questions, please call the restaurant on +263771234567.",
    );
    expect((await row(id)).status).toBe("sent");
  });

  it("requires status = cancelled: a booking that is confirmed again or still confirmed is marked cancelled, not sent", async () => {
    const { id, restaurantId } = await cancelledRow("1995-03-03T10:00:00Z", { status: "confirmed" });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-03T10:05:00Z"), choice);

    expect(sent.filter((message) => message.body[1] === `Restaurant ${restaurantId}`)).toEqual([]);
    expect(await row(id)).toMatchObject({ status: "cancelled", providerMessageId: null });
  });

  it("doesn't send a booking_confirmed for a cancelled booking, as before", async () => {
    const { id, manageToken } = await queued("1995-03-04T10:00:00Z", { status: "cancelled" });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-04T10:05:00Z"), choice);

    expect(sentAmong(sent, { manageToken })).toEqual([]);
    expect((await row(id)).status).toBe("cancelled");
  });

  it("sends the cancelled booking its cancellation and not a reminder", async () => {
    const { id, bookingId, restaurantId } = await cancelledRow("1995-03-05T10:00:00Z");
    // A reminder that is due too, as one would be if cancelling didn't cancel it (#45).
    const [reminder] = await owner.db
      .insert(notifications)
      .values({ restaurantId, bookingId, kind: "booking_reminder", scheduledFor: new Date("1995-03-05T10:00:00Z") })
      .returning({ id: notifications.id });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-05T10:05:00Z"), choice);

    const ours = sent.filter((message) => message.body.includes(`Restaurant ${restaurantId}`));
    expect(ours.map(({ template }) => template)).toEqual(["booking_cancelled"]);
    expect((await row(id)).status).toBe("sent");
    expect((await row(reminder.id)).status).not.toBe("sent");
  });

  it("is sent only to a guest who still has a number and the opt-in", async () => {
    const noOptIn = await cancelledRow("1995-03-06T10:00:00Z", { optIn: false });
    const noPhone = await cancelledRow("1995-03-06T10:00:00Z", { phone: null });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-06T10:05:00Z"), choice);

    const ids = [noOptIn.restaurantId, noPhone.restaurantId].map((id) => `Restaurant ${id}`);
    expect(sent.filter((message) => ids.includes(message.body[1]))).toEqual([]);
    expect((await row(noOptIn.id)).status).toBe("cancelled");
    expect((await row(noPhone.id)).status).toBe("cancelled");
  });

  it("sends a staff cancellation even when the restaurant has no phone, without a number in it", async () => {
    const restaurant = await bookableRestaurant(owner.db);
    await owner.db.update(restaurants).set({ contactPhone: null }).where(eq(restaurants.id, restaurant.restaurantId));
    const { id } = await cancelledRow("1995-03-07T10:00:00Z", { restaurant, cancelledBy: "staff" });
    const { sent, choice } = recordingSender();

    await sendDueNotifications(system.db, new Date("1995-03-07T10:05:00Z"), choice);

    expect(sent.find((message) => message.body[1] === `Restaurant ${restaurant.restaurantId}`)?.body[4]).toBe(
      "If you have any questions, please contact the restaurant.",
    );
    expect((await row(id)).status).toBe("sent");
  });

  // Recovery runs every 5 minutes and filters on status = 'sending' and claimed_at. Behaviour
  // can't show an index exists (a scan gives the same rows), so this asks the planner: with
  // sequential scans off it must have an index to use for the query recover() runs.
  it("has an index the stuck-in-sending query can use, so recovery doesn't read the whole table", async () => {
    const plan = await system.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const result = await tx.execute(sql`explain select restaurant_id, id from notifications
        where status = 'sending' and claimed_at < now() - interval '10 minutes'
        limit 50 for update skip locked`);
      return result.rows.map((r) => Object.values(r)[0]).join("\n");
    });

    expect(plan).toContain("notifications_sending_claimed_at_index");
  });
});
