import { describe, expect, it } from "vitest";
import { bookingConfirmed, renderText, TEMPLATE_LANGUAGE } from "./templates";

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
