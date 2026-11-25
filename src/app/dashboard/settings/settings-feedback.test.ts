import { describe, expect, it } from "vitest";
import { savedMessage, type SettingsValues, settingsDirty } from "./settings-feedback";

const saved: SettingsValues = {
  name: "Mama's Kitchen",
  contactPhone: "+263771234567",
  wifiName: "",
  wifiPassword: "",
  currencyMode: "usd_only",
  timezone: "Africa/Harare",
};

describe("settingsDirty", () => {
  it("is clean until something differs from what was saved", () => {
    expect(settingsDirty(saved, { ...saved })).toBe(false);
    expect(settingsDirty(saved, { ...saved, wifiName: "Guest" })).toBe(true);
    expect(settingsDirty(saved, { ...saved, currencyMode: "both" })).toBe(true);
  });

  it("is clean again once an edit is undone", () => {
    expect(settingsDirty(saved, { ...saved, name: "x" })).toBe(true);
    expect(settingsDirty(saved, { ...saved, name: saved.name })).toBe(false);
  });
});

describe("savedMessage", () => {
  it("only mentions online booking when the save switched it off", () => {
    expect(savedMessage(false)).toBe("Settings saved.");
    expect(savedMessage(true)).toContain("Online booking has switched off");
  });
});
