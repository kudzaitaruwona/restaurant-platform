import { describe, expect, it } from "vitest";
import { displayPhone } from "./display-phone";

describe("displayPhone", () => {
  it("groups a Zimbabwean number as a guest reads it", () => {
    expect(displayPhone("+263771234567")).toBe("+263 77 123 4567");
  });

  it("shows any other number as stored", () => {
    expect(displayPhone("+12")).toBe("+12");
    expect(displayPhone("+27821234567")).toBe("+27821234567");
    expect(displayPhone("+2637712345678")).toBe("+2637712345678");
  });
});
