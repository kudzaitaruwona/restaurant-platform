import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest's globals are off, so Testing Library can't register this itself.
afterEach(cleanup);

// A followed link that nothing stopped would otherwise load the page it names.
window.happyDOM.settings.navigation.disableMainFrameNavigation = true;

/*
 * Three things a browser does that happy-dom doesn't, and the shared forms and
 * dialogs depend on. Everything else here is happy-dom as it is.
 */

// Focus fixup: a control that has been disabled, or sits in a fieldset that has
// been, no longer holds focus (a pending ActionForm's disabled fieldset drops
// it, so focus waits on "Saving"). Reported at once, as a browser's
// document.activeElement does after the change.
let holder: object | null = document;
let activeElement: PropertyDescriptor | undefined;
while (holder && !(activeElement = Object.getOwnPropertyDescriptor(holder, "activeElement"))) {
  holder = Object.getPrototypeOf(holder);
}
if (activeElement?.get) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get() {
      const active = activeElement.get!.call(document) as Element | null;
      if (active instanceof HTMLElement && active !== document.body) {
        if (active.closest("fieldset[disabled]") || active.hasAttribute("disabled")) {
          active.blur();
          return document.body;
        }
      }
      return active;
    },
  });
}

// A dialog's `close` event is queued, not fired inside close(): a listener
// removed and added again by the render that closed it still hears it.
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, returnValue?: string) {
  const wasOpen = this.open;
  this.removeAttribute("open");
  this.returnValue = returnValue === undefined ? "" : String(returnValue);
  if (wasOpen) setTimeout(() => this.dispatchEvent(new Event("close")), 0);
};

// A form's `reset` event fires before its controls go back, so a listener can
// read what they held (RememberedCategorySelect does). happy-dom fires it after.
HTMLFormElement.prototype.reset = function (this: HTMLFormElement) {
  if (!this.dispatchEvent(new Event("reset", { bubbles: true, cancelable: true }))) return;
  for (const control of Array.from(this.elements)) {
    if (control instanceof HTMLInputElement) {
      control.value = control.defaultValue;
      control.checked = control.defaultChecked;
    } else if (control instanceof HTMLTextAreaElement) {
      control.value = control.defaultValue;
    } else if (control instanceof HTMLSelectElement) {
      const first = Array.from(control.options).find((option) => option.defaultSelected) ?? control.options[0];
      if (first) first.selected = true;
    }
  }
};
