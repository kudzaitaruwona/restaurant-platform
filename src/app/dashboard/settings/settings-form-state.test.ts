import { describe, expect, it } from "vitest";
import type { SettingsValues } from "./settings-feedback";
import {
  edited,
  type FormState,
  initialFormState,
  left,
  linkTarget,
  received,
  saveAccepted,
} from "./settings-form-state";

const stored: SettingsValues = {
  name: "Mama's Kitchen",
  contactPhone: "+263771234567",
  wifiName: "",
  wifiPassword: "",
  currencyMode: "usd_only",
  timezone: "Africa/Harare",
};
const start = initialFormState(stored);

/** What the fields hold: a remount starts them again from the baseline. */
const shown = (before: FormState, after: FormState, inFields: SettingsValues) =>
  after.version === before.version ? inFields : after.baseline;

describe("typing", () => {
  it("changes nothing while the form stays as dirty as it was, so a keystroke renders nothing", () => {
    const once = edited(start, { ...stored, name: "Baba's Kitchen" });
    expect(edited(once, { ...stored, name: "Baba's Kitchen!" })).toBe(once);
    expect(edited(start, stored)).toBe(start);
  });

  it("changes when it turns dirty, and when it is back to what was saved", () => {
    const dirty = edited(start, { ...stored, name: "Baba's Kitchen" });
    expect(dirty).not.toBe(start);
    expect(edited(dirty, stored)).toMatchObject({ dirty: false });
  });
});

describe("typing while a save is out", () => {
  const sent = { ...stored, name: "Baba's Kitchen" };
  const during = { ...sent, name: "Baba's Kitchen Two" };

  it("keeps what was typed after it was sent as unsaved, and warns about it", () => {
    const accepted = saveAccepted(edited(start, sent), sent, stored, during);

    expect(accepted.baseline).toEqual(sent);
    expect(accepted.dirty).toBe(true);
    // The refresh that follows can't put the old values over it.
    expect(received(accepted, sent)).toBe(accepted);
  });

  it("is saved cleanly when nothing was typed meanwhile", () => {
    expect(saveAccepted(edited(start, sent), sent, stored, sent).dirty).toBe(false);
    expect(saveAccepted(edited(start, sent), sent, stored).dirty).toBe(false);
  });
});

describe("saving", () => {
  it.each([
    { currencyMode: "both" },
    { timezone: "Africa/Johannesburg" },
    { name: "Baba's Kitchen" },
  ])("keeps a changed %j after the refresh that follows", (change) => {
    const typed = { ...stored, ...change };
    const before = edited(start, typed);
    expect(before.dirty).toBe(true);

    const accepted = saveAccepted(before, typed, stored);
    // Until the refresh lands, the old props must not come back into the fields.
    expect(received(accepted, stored)).toBe(accepted);
    expect(accepted.dirty).toBe(false);

    const refreshed = received(accepted, { ...typed });
    expect(shown(before, refreshed, typed)).toEqual(typed);
    expect(refreshed.dirty).toBe(false);
    // What the next save would post is not the old value, and is not an edit.
    expect(edited(refreshed, typed).dirty).toBe(false);
  });

  it("shows a phone number as it was stored, even when that is what it was before", () => {
    const typed = { ...stored, contactPhone: "0771234567" };
    const accepted = saveAccepted(edited(start, typed), typed, stored);
    const refreshed = received(accepted, { ...stored });
    expect(shown(accepted, refreshed, typed)).toEqual(stored);
  });

  it("settles: the same saved values again change nothing", () => {
    const typed = { ...stored, currencyMode: "both" };
    const refreshed = received(saveAccepted(start, typed, stored), { ...typed });
    expect(received(refreshed, { ...typed })).toBe(refreshed);
  });

  it("keeps what was saved if the screen comes back still holding the old props", () => {
    const typed = { ...stored, currencyMode: "both" };
    const accepted = saveAccepted(edited(start, typed), typed, stored);
    expect(shown(start, received(accepted, stored), typed)).toEqual(typed);
    expect(edited(accepted, { ...typed, name: "x" }).dirty).toBe(true);
    expect(edited(accepted, typed).dirty).toBe(false);
  });
});

describe("unsaved edits", () => {
  const typed = { ...stored, name: "x" };
  const dirty = edited(start, typed);

  it("survive the screen being hidden and shown again", () => {
    expect(received(dirty, stored)).toBe(dirty);
  });

  it("survive a refresh, even one that brings new values", () => {
    expect(received(dirty, { ...stored, wifiName: "Guest" })).toBe(dirty);
    const accepted = edited(saveAccepted(start, stored, stored), typed);
    expect(received(accepted, { ...stored, wifiName: "Guest" })).toBe(accepted);
  });

  it("go when Leave is chosen, even to this same page", () => {
    const after = left(dirty);
    expect(after.dirty).toBe(false);
    expect(shown(dirty, after, typed)).toEqual(stored);
  });

  it("none: new saved values replace the fields", () => {
    const newer = { ...stored, wifiName: "Guest" };
    expect(shown(start, received(start, newer), stored)).toEqual(newer);
    expect(received(start, { ...stored })).toBe(start);
  });
});

describe("linkTarget", () => {
  const here = "https://app.test/dashboard/settings?x=1";
  const to = (href: string) => linkTarget(new URL(href, here).href, here);

  it("is where a link in the app goes", () => {
    expect(to("/dashboard/menu?a=b#c")).toBe("/dashboard/menu?a=b#c");
    expect(to("/dashboard/settings?x=1")).toBe("/dashboard/settings?x=1");
    expect(to("/dashboard/settings#top")).toBe("/dashboard/settings#top"); // another ?x
  });

  it("leaves alone another site and a jump within this page", () => {
    expect(to("https://elsewhere.test/")).toBeUndefined();
    expect(to("#main")).toBeUndefined();
    expect(to("#")).toBeUndefined();
  });
});
