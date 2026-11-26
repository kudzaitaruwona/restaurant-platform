import { type SettingsValues, settingsDirty } from "./settings-feedback";

/**
 * Which values the settings fields start from. The fields are uncontrolled, so
 * new values only show when they are remounted: `version` is their key. React
 * doesn't move a `<select>` when its `defaultValue` changes, so resetting the
 * form would put back the old choice instead.
 */
export type FormState = {
  baseline: SettingsValues;
  version: number;
  /** Something typed or chosen differs from the baseline. */
  dirty: boolean;
  /** After a save: the props from before it, which say nothing about what was stored. */
  outdated?: SettingsValues;
};

export const initialFormState = (saved: SettingsValues): FormState => ({
  baseline: saved,
  version: 0,
  dirty: false,
});

/** The same state when nothing it says changes, so a keystroke in an edited form renders nothing. */
export function edited(state: FormState, now: SettingsValues): FormState {
  const dirty = settingsDirty(state.baseline, now);
  return dirty === state.dirty ? state : { ...state, dirty };
}

/**
 * The server took `posted` while the screen still held `saved`. `now` is what the
 * fields hold by then: the form stays editable while a save is out, so it may
 * be more than was sent, and that is still unsaved.
 */
export const saveAccepted = (
  state: FormState,
  posted: SettingsValues,
  saved: SettingsValues,
  now: SettingsValues = posted,
): FormState => ({
  ...state,
  baseline: posted,
  dirty: settingsDirty(posted, now),
  outdated: saved,
});

/**
 * The values the screen now holds. Unsaved edits always win. The first new ones
 * after a save always go in the fields, because what was stored can differ from
 * what was typed (a phone number). Returns the same state when nothing changes.
 */
export function received(state: FormState, saved: SettingsValues): FormState {
  if (state.dirty) return state;
  const isNew = state.outdated
    ? saved !== state.outdated
    : settingsDirty(state.baseline, saved);
  return isNew ? { baseline: saved, version: state.version + 1, dirty: false } : state;
}

/** Leaving without saving: the link may lead back to this page, so the edits go now. */
export const left = (state: FormState): FormState => ({
  ...state,
  version: state.version + 1,
  dirty: false,
});

/** Where a followed link goes, if it leaves this view of the app. */
export function linkTarget(href: string, here: string) {
  const to = new URL(href);
  const from = new URL(here);
  if (to.origin !== from.origin) return undefined;
  const samePage = to.pathname === from.pathname && to.search === from.search;
  // A jump within the page loses nothing.
  if (samePage && href.includes("#")) return undefined;
  return to.pathname + to.search + to.hash;
}
