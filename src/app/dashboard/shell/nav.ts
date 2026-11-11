/**
 * The staff navigation (S-41): what the rail lists, for whom, and which item a
 * path belongs to. Owner-only items follow S-26, as the dashboard's links did.
 */

export type NavKey =
  | "kitchen"
  | "floor"
  | "bookings"
  | "menu"
  | "tables"
  | "bookingSettings"
  | "settings"
  | "staff";

export type NavItem = {
  key: NavKey;
  href: string;
  label: string;
  group: "Service" | "Setup";
  ownerOnly: boolean;
};

export const navItems: readonly NavItem[] = [
  { key: "kitchen", href: "/dashboard/kitchen", label: "Kitchen", group: "Service", ownerOnly: false },
  { key: "floor", href: "/dashboard/floor", label: "Floor", group: "Service", ownerOnly: false },
  { key: "bookings", href: "/dashboard/bookings", label: "Bookings", group: "Service", ownerOnly: false },
  { key: "menu", href: "/dashboard/menu", label: "Menu", group: "Setup", ownerOnly: false },
  { key: "tables", href: "/dashboard/tables", label: "Tables", group: "Setup", ownerOnly: true },
  { key: "bookingSettings", href: "/dashboard/bookings/settings", label: "Booking settings", group: "Setup", ownerOnly: true },
  { key: "settings", href: "/dashboard/settings", label: "Restaurant settings", group: "Setup", ownerOnly: true },
  { key: "staff", href: "/dashboard/staff", label: "Staff", group: "Setup", ownerOnly: true },
];

/** The items a role sees, in their groups and order. */
export function navFor(role: "owner" | "staff") {
  const items = navItems.filter((item) => role === "owner" || !item.ownerOnly);
  return (["Service", "Setup"] as const)
    .map((group) => ({ group, items: items.filter((item) => item.group === group) }))
    .filter(({ items }) => items.length > 0);
}

/**
 * The item a path belongs to: the longest href that is the path or a parent of
 * it, so /dashboard/bookings/new is Bookings and /dashboard/bookings/settings is
 * Booking settings. The dashboard home belongs to none.
 */
export function activeItem(pathname: string, items: readonly NavItem[] = navItems) {
  return items
    .filter(({ href }) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** Up to two initials for the restaurant mark and the avatar: "Msasa Grill" is "MG". */
export function initialsOf(name: string) {
  const words = name.trim().split(/\s+/).filter((word) => /\p{L}|\p{N}/u.test(word));
  const letters = words.slice(0, 2).map((word) => [...word.replace(/^[^\p{L}\p{N}]+/u, "")][0] ?? "");
  return letters.join("").toUpperCase() || "?";
}
