/** The settings form's fields, as the form posts them. */
export type SettingsValues = Record<
  "name" | "contactPhone" | "wifiName" | "wifiPassword" | "currencyMode" | "timezone",
  string
>;

/** True once anything typed or chosen differs from what was last saved. */
export const settingsDirty = (saved: SettingsValues, now: SettingsValues) =>
  (Object.keys(saved) as (keyof SettingsValues)[]).some((key) => saved[key] !== now[key]);

/** What a save did, said once and only as far as it is true. */
export const savedMessage = (bookingSwitchedOff: boolean) =>
  bookingSwitchedOff
    ? "Settings saved. Online booking has switched off because there is no contact phone. Add one, then turn booking back on in Booking settings."
    : "Settings saved.";
