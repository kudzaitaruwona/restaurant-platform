import type { Window as HappyWindow } from "happy-dom";

declare global {
  interface Window {
    /** happy-dom's own controls, present in the dom project's environment. */
    happyDOM: HappyWindow["happyDOM"];
  }
}
