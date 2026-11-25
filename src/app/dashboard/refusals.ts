/**
 * A page of ActionForms shows one refusal at a time: when any form on the page
 * is sent, the others clear theirs, so two refused actions never stack.
 */
type Listener = (sender: symbol) => void;
const listeners = new Set<Listener>();

/** Tells every other form on the page that this one is being sent. */
export function announceSend(sender: symbol) {
  for (const listener of [...listeners]) listener(sender);
}

/** Calls `clear` whenever a different form is sent; returns the unsubscribe. */
export function clearOnOtherSend(self: symbol, clear: () => void) {
  const listener: Listener = (sender) => {
    if (sender !== self) clear();
  };
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
