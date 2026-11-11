import { describe, expect, it } from "vitest";
import { activeItem, initialsOf, navFor } from "./nav";

describe("the staff navigation", () => {
  it("gives an owner every screen, in Service and Setup", () => {
    expect(navFor("owner").map(({ group }) => group)).toEqual(["Service", "Setup"]);
    const labels = navFor("owner").flatMap(({ items }) => items.map(({ label }) => label));
    expect(labels).toEqual([
      "Kitchen",
      "Floor",
      "Bookings",
      "Menu",
      "Tables",
      "Booking settings",
      "Restaurant settings",
      "Staff",
    ]);
  });

  it("keeps the owner-only screens (S-26) from staff, as the dashboard's links did", () => {
    const hrefs = navFor("staff").flatMap(({ items }) => items.map(({ href }) => href));
    expect(hrefs).toEqual([
      "/dashboard/kitchen",
      "/dashboard/floor",
      "/dashboard/bookings",
      "/dashboard/menu",
    ]);
  });

  it.each([
    ["/dashboard/bookings", "bookings"],
    ["/dashboard/bookings/new", "bookings"],
    ["/dashboard/bookings/settings", "bookingSettings"],
    ["/dashboard/floor/3f1c", "floor"],
    ["/dashboard/tables/print", "tables"],
    ["/dashboard/kitchen", "kitchen"],
  ])("marks %s as %s, by the longest matching path", (path, key) => {
    expect(activeItem(path)?.key).toBe(key);
  });

  it("marks nothing on the dashboard home, or a path that only looks like one", () => {
    expect(activeItem("/dashboard")).toBeUndefined();
    expect(activeItem("/dashboard/bookingsx")).toBeUndefined();
  });

  it.each([
    ["Msasa Grill", "MG"],
    ["Restaurant A", "RA"],
    ["Mama's <Kitchen> Harare", "MK"],
    ["  tendai  ", "T"],
    ["", "?"],
  ])("makes %j into the initials %j", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});
