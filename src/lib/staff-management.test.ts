import { describe, expect, it } from "vitest";
import { parseNewStaff, parseRole } from "./staff-management";

function form(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

const valid = { email: "tendai@example.test", displayName: "Tendai", role: "staff" };

describe("parseNewStaff", () => {
  it("accepts a complete form and drops anything else", () => {
    expect(
      parseNewStaff(form({ ...valid, restaurantId: "b", kind: "platform_admin", active: "false" })),
    ).toEqual({ success: true, data: valid });
  });

  it("stores an email in one form, so case can't make a second login", () => {
    expect(
      parseNewStaff(form({ ...valid, email: "  Tendai@Example.TEST " })),
    ).toMatchObject({ data: { email: "tendai@example.test" } });
  });

  it.each([
    { email: "not-an-email" },
    { email: "" },
    { displayName: "   " },
    { displayName: "x".repeat(201) },
    { role: "platform_admin" },
    { role: "" },
  ])("refuses %j", (overrides) => {
    expect(parseNewStaff(form({ ...valid, ...overrides }))).toMatchObject({
      success: false,
    });
  });
});

describe("parseRole", () => {
  it.each(["owner", "staff"])("accepts %s", (role) => {
    expect(parseRole(form({ role }))).toEqual({ success: true, data: role });
  });

  it.each([{ role: "admin" }, {}])("refuses %j", (fields) => {
    expect(parseRole(form(fields as Record<string, string>))).toMatchObject({
      success: false,
    });
  });
});
