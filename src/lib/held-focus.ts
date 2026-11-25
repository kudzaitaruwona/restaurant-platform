/** A control's place on the page: itself, then each parent and where in it the one before sat. */
export type Place = { element: Element; parents: { parent: Element; index: number }[] };

/** Taken before a save, since the refresh after it may take the control away. */
export function placeOf(element: Element): Place {
  const parents: Place["parents"] = [];
  let child = element;
  while (child.parentElement && child.parentElement.tagName !== "BODY") {
    const parent = child.parentElement;
    parents.push({ parent, index: [...parent.children].indexOf(child) });
    child = parent;
  }
  return { element, parents };
}

/**
 * Where focus may go, best first: the control; else what is around it; or, if it
 * is gone, what took its place (the next row), what came before it, and what is
 * around that.
 */
export function placesToFocus({ element, parents }: Place): Element[] {
  const places: Element[] = element.isConnected ? [element] : [];
  let child = element;
  for (const { parent, index } of parents) {
    if (parent.isConnected) {
      if (!child.isConnected) {
        places.push(...[parent.children[index], parent.children[index - 1]].filter((place) => place !== undefined));
      }
      places.push(parent);
    }
    child = parent;
  }
  return places;
}

/** Whether focus is nowhere: on the body, or on a control that is disabled or gone. */
export const focusLost = (active: Element | null, body: Element) =>
  !active || active === body || !active.isConnected || active.matches(":disabled");

/** Focuses it, as a place to carry on from if it isn't a control. False if it can't be (hidden, disabled). */
function take(element: Element) {
  if (!(element instanceof HTMLElement)) return false;
  element.focus({ preventScroll: true });
  if (document.activeElement === element) return true;
  if (element.hasAttribute("tabindex") || element.matches(":disabled")) return false;
  element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
  const taken = document.activeElement === element;
  if (taken) element.addEventListener("blur", () => element.removeAttribute("tabindex"), { once: true });
  else element.removeAttribute("tabindex");
  return taken;
}

/** Puts focus back where it was, or close by, unless the person has moved on. */
export function giveFocusBack(place: Place) {
  if (focusLost(document.activeElement, document.body)) placesToFocus(place).some(take);
}
