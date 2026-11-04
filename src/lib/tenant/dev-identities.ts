/**
 * The seeded identities behind DEV_AUTH_BYPASS (S-25). The ids are fixed so the
 * switcher can offer them without a query: RLS rightly stops the app role from
 * listing staff across restaurants.
 */

const restaurantA = "00000000-0000-4000-8000-00000000000a";
const restaurantB = "00000000-0000-4000-8000-00000000000b";

export const devRestaurants = [
  { id: restaurantA, name: "Restaurant A", slug: "restaurant-a" },
  { id: restaurantB, name: "Restaurant B", slug: "restaurant-b" },
];

export type DevIdentity = (typeof devIdentities)[number];

export const devIdentities = [
  {
    key: "a-owner",
    label: "Restaurant A owner",
    restaurantId: restaurantA,
    staffId: "00000000-0000-4000-8000-0000000000a1",
    role: "owner",
  },
  {
    key: "a-staff",
    label: "Restaurant A staff",
    restaurantId: restaurantA,
    staffId: "00000000-0000-4000-8000-0000000000a2",
    role: "staff",
  },
  {
    key: "b-owner",
    label: "Restaurant B owner",
    restaurantId: restaurantB,
    staffId: "00000000-0000-4000-8000-0000000000b1",
    role: "owner",
  },
  {
    key: "b-staff",
    label: "Restaurant B staff",
    restaurantId: restaurantB,
    staffId: "00000000-0000-4000-8000-0000000000b2",
    role: "staff",
  },
] as const;

/** A platform admin, not a staff member: it belongs to no restaurant. */
export const devPlatformAdmin = {
  key: "platform-admin",
  label: "Platform admin",
  platformAdminId: "00000000-0000-4000-8000-0000000000f1",
  email: "platform-admin@dev.example.test",
  // The bypass has no real session, but entering a restaurant needs one to hang
  // off, so the seed makes it (src/db/seed.ts).
  sessionId: "dev-bypass-platform-admin",
} as const;

export type DevPlatformAdmin = typeof devPlatformAdmin;

/** Everyone the dev switcher offers. */
export const devSwitcherIdentities = [...devIdentities, devPlatformAdmin];

/** The cookie that holds the chosen identity's key, never a raw id. */
export const DEV_IDENTITY_COOKIE = "dev_identity";

/** Who you are until you pick someone else in the switcher. */
export const defaultDevIdentity = devIdentities[0];

export const findDevIdentity = (key: string): DevIdentity | undefined =>
  devIdentities.find((identity) => identity.key === key);
