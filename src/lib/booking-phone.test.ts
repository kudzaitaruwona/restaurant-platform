import { describe, expect, it } from "vitest";
import { parseGuestRequest, toE164 } from "@/lib/bookings";
import { parseStaffRequest } from "@/lib/booking-staff";

// #88: the guest form and staff Add booking share one phone rule.
const date = "2030-01-15";
const fields = (countryCode: string, phone: string) => {
  const body = new FormData();
  const all = { party: "2", date, time: "19:00", name: "Tariro", countryCode, phone, consent: "on", whatsapp: "on" };
  for (const [k, v] of Object.entries(all)) body.set(k, v);
  return body;
};
const guest = (cc: string, phone: string) => {
  const r = parseGuestRequest(fields(cc, phone));
  return r.success ? r.data.phone : r.message;
};
const staff = (cc: string, phone: string) => {
  const r = parseStaffRequest(fields(cc, phone));
  return r.success ? r.data.phone : r.message;
};

const normalised: [string, string, string][] = [
  ["+263", "0772000102", "+263772000102"],
  ["+263", "772000102", "+263772000102"],
  ["+263", "263772000102", "+263772000102"],
  ["+263", "00263772000103", "+263772000103"],
  ["+263", "0263772000102", "+263772000102"],
  ["+263", "+263 77 200 0104", "+263772000104"],
  ["263", "0772000102", "+263772000102"],
  ["263", "263772000102", "+263772000102"],
  ["00263", "772000102", "+263772000102"],
  ["+263", "+27 82 123 4567", "+27821234567"],
  ["+263", "0027821234567", "+27821234567"],
  ["+44", "07700 900123", "+447700900123"],
  ["+44", "447700900123", "+447700900123"],
  ["+44", "00447700900123", "+447700900123"],
  ["+1", "1 415 555 2671", "+14155552671"],
  ["+1", "415 555 2671", "+14155552671"],
];

describe("the phone rule, guest and staff alike", () => {
  it.each(normalised)("code %j, typed %j gives %j", (cc, typed, want) => {
    expect(toE164(cc, typed)).toBe(want);
    expect(guest(cc, typed)).toBe(want);
    expect(staff(cc, typed)).toBe(want);
  });

  it.each([
    ["+263", "077 200 00"],
    ["+263", "0772000"],
    ["+263", "263772000"],
    ["+263", "2637720001020"],
    ["+44", "0770090"],
    ["+263", "+263 77 200"],
  ])("refuses an implausibly short or long number: %j %j", (cc, typed) => {
    expect(guest(cc, typed)).toMatch(/too short|WhatsApp number/);
    expect(staff(cc, typed)).toMatch(/too short|WhatsApp number/);
    expect(guest(cc, typed)).not.toMatch(/^\+/);
  });

  it("says plainly that a number is too short", () => {
    expect(guest("+263", "077 200 00")).toBe("That number looks too short. Check the digits and the country code.");
  });

  it.each(["abc", "+", "+0", "12345", "+2a"])("refuses a country code that isn't one: %j", (cc) => {
    expect(guest(cc, "0772000102")).toBe("Enter the country code with a +, like +263.");
    expect(staff(cc, "0772000102")).toBe("Enter the country code with a +, like +263.");
  });

  it("never doubles a code", () => {
    for (const [cc, typed] of [["+263", "263772000102"], ["+263", "00263772000103"]]) {
      expect(String(guest(cc, typed))).not.toContain("263263");
    }
  });
});
