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
  // A national number that happens to begin with its own country's code keeps the code.
  ["+91", "9123456789", "+919123456789"],
  ["+91", "09123456789", "+919123456789"],
  ["+91", "919123456789", "+919123456789"],
  ["+39", "391 234 5678", "+393912345678"],
  ["+39", "39 391 234 5678", "+393912345678"],
  ["+84", "084 123 4567", "+84841234567"],
  ["+84", "84 84 123 4567", "+84841234567"],
  ["+7", "701 234 5678", "+77012345678"],
  ["+7", "7 701 234 5678", "+77012345678"],
  ["+55", "55 99123 4567", "+5555991234567"],
  ["+49", "4915112345678", "+4915112345678"],
  ["+49", "04921 123456", "+494921123456"],
  // The trunk 0 kept after the code.
  ["+263", "+263 0772000102", "+263772000102"],
  ["+263", "2630772000102", "+263772000102"],
  ["+263", "002630772000102", "+263772000102"],
  ["+27", "+263 (0)77 200 0102", "+263772000102"],
];

const short = "That number looks too short. Check the digits and the country code.";
const long = "That number looks too long. Check the digits and the country code.";
const plus = "We can't tell which country that number is in. Enter it in full, starting with + and the country code.";
const unusable = "Enter a WhatsApp number we can reach you on.";

describe("the phone rule, guest and staff alike", () => {
  it.each(normalised)("code %j, typed %j gives %j", (cc, typed, want) => {
    expect(toE164(cc, typed)).toBe(want);
    expect(guest(cc, typed)).toBe(want);
    expect(staff(cc, typed)).toBe(want);
  });

  it.each([
    ["+263", "077 200 00", short],
    ["+263", "0772000", short],
    ["+263", "263772000", short],
    ["+263", "0263123456", short],
    ["+263", "2637720001020", long],
    ["+263", "27821234567", long],
    ["+263", "+263263772000102", long],
    ["+263", "+1234567890123456", long],
    ["+44", "0770090", short],
    ["+263", "+263 77 200", short],
    // The code twice, and by its length a number.
    ["+263", "+263263772000", unusable],
    // Both readings, or neither, are a number: not guessed at.
    ["+43", "436641234567", plus],
    ["+43", "0436 123 4567", plus],
    ["+44", "44770090", plus],
    ["+44", "4407700900123", plus],
  ])("refuses %j %j, saying why", (cc, typed, why) => {
    expect(guest(cc, typed)).toBe(why);
    expect(staff(cc, typed)).toBe(why);
  });

  it("staff: the code box is checked only for a number that needs it", () => {
    for (const cc of ["", "abc"]) {
      expect(staff(cc, "")).toBeNull();
      expect(staff(cc, " ")).toBeNull();
      expect(staff(cc, "+263 772 000 102")).toBe("+263772000102");
      expect(staff(cc, "00263772000102")).toBe("+263772000102");
      expect(staff(cc, "0772000102")).toBe("Enter the country code with a +, like +263.");
    }
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
