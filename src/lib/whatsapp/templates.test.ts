import { describe, expect, it } from "vitest";
import { bookingCancelled, bookingConfirmed, renderText, TEMPLATE_LANGUAGE } from "./templates";

const booking = {
  guestName: "Tariro Moyo",
  restaurantName: "Kudu Grill",
  partySize: 4,
  // 19:30 in Harare (UTC+2), on Friday 6 November 2026.
  startsAt: new Date("2026-11-06T17:30:00Z"),
  timezone: "Africa/Harare",
  restaurantPhone: "+263771234567",
  guestPhone: "+263779876543",
  manageToken: "AbCdEfGhIjKlMnOpQrStUv",
};

describe("booking_confirmed (spec 05)", () => {
  it("fills {{1}} to {{6}}: guest, restaurant, party, date, time, restaurant phone, and the manage link's token", () => {
    expect(bookingConfirmed(booking)).toEqual({
      to: "+263779876543",
      template: "booking_confirmed",
      language: "en",
      body: ["Tariro Moyo", "Kudu Grill", "4", "Fri 6 Nov", "19:30", "+263771234567"],
      manageToken: "AbCdEfGhIjKlMnOpQrStUv",
    });
  });

  it("gives the date and time on the restaurant's clock, not UTC's or the server's", () => {
    // 23:30 UTC on 6 Nov is 01:30 on 7 Nov in Harare, and 18:30 on 6 Nov in New York.
    const late = { ...booking, startsAt: new Date("2026-11-06T23:30:00Z") };
    expect(bookingConfirmed(late).body.slice(3, 5)).toEqual(["Sat 7 Nov", "01:30"]);
    expect(bookingConfirmed({ ...late, timezone: "America/New_York" }).body.slice(3, 5)).toEqual([
      "Fri 6 Nov",
      "18:30",
    ]);
  });

  it("uses the one template language, en", () => {
    expect(TEMPLATE_LANGUAGE).toBe("en");
  });

  it("reads as spec 05's wording once filled in", () => {
    expect(renderText(bookingConfirmed(booking))).toBe(
      "Hi Tariro Moyo, your table at Kudu Grill is confirmed for 4 people on Fri 6 Nov at 19:30. " +
        "Need to cancel? Use the button below. This number doesn't receive replies — to reach the restaurant, call +263771234567.\n" +
        "[Manage booking] /b/AbCdEfGhIjKlMnOpQrStUv",
    );
  });
});

describe("booking_cancelled (spec 05)", () => {
  const cancelled = { ...booking, cancelledBy: "guest" as const };

  it("fills {{1}} to {{5}} and carries no manage link: a cancelled booking has nothing to manage", () => {
    expect(bookingCancelled(cancelled)).toEqual({
      to: "+263779876543",
      template: "booking_cancelled",
      language: "en",
      body: ["Tariro Moyo", "Kudu Grill", "Fri 6 Nov", "19:30", "We hope to see you another time."],
    });
  });

  it("says the restaurant's contact line when staff cancelled", () => {
    expect(bookingCancelled({ ...cancelled, cancelledBy: "staff" }).body[4]).toBe(
      "If you have any questions, please call the restaurant on +263771234567.",
    );
  });

  it("still sends a staff cancellation for a restaurant with no phone, without a number", () => {
    expect(bookingCancelled({ ...cancelled, cancelledBy: "staff", restaurantPhone: null }).body[4]).toBe(
      "If you have any questions, please contact the restaurant.",
    );
  });

  it("gives the date and time on the restaurant's clock", () => {
    const late = { ...cancelled, startsAt: new Date("2026-11-06T23:30:00Z") };
    expect(bookingCancelled(late).body.slice(2, 4)).toEqual(["Sat 7 Nov", "01:30"]);
  });

  it("reads as spec 05's wording once filled in", () => {
    expect(renderText(bookingCancelled(cancelled))).toBe(
      "Hi Tariro Moyo, your booking at Kudu Grill on Fri 6 Nov at 19:30 has been cancelled. We hope to see you another time.",
    );
  });
});
