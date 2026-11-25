import { describe, expect, it } from "vitest";
import { focusLost, placeOf, placesToFocus } from "./held-focus";

/** A stand-in for an element: just the tree the focus rules read (no DOM here). */
class Node {
  parentElement: Node | null = null;
  children: Node[] = [];
  disabled = false;
  tagName: string;
  constructor(public name: string, ...children: Node[]) {
    this.tagName = name.toUpperCase();
    for (const child of children) this.append(child);
  }
  append(child: Node, at = this.children.length) {
    child.parentElement = this;
    this.children.splice(at, 0, child);
    return child;
  }
  remove() {
    const siblings = this.parentElement?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  get isConnected(): boolean {
    return this.name === "body" || (this.parentElement?.isConnected ?? false);
  }
  matches() {
    return this.disabled;
  }
}

const as = (node: Node) => node as unknown as HTMLElement;
const order = (from: ReturnType<typeof placeOf>) => placesToFocus(from).map((el) => (el as unknown as Node).name);

/** body > main > list > three rows, each with a form holding one button. */
function page() {
  const rows = ["one", "two", "three"].map((name) => {
    const button = new Node(`${name} button`);
    return { row: new Node(`${name} row`, new Node(`${name} form`, button)), button };
  });
  const list = new Node("list", ...rows.map(({ row }) => row));
  const main = new Node("main", list);
  const body = new Node("body", main);
  return { body, main, list, rows };
}

describe("where focus goes after a send (#111)", () => {
  it("goes back to the control that was used", () => {
    const { rows } = page();
    expect(order(placeOf(as(rows[1].button)))[0]).toBe("two button");
  });

  it("goes to what is around a control that can't take it any more (Move up, now at the top)", () => {
    const { rows } = page();
    expect(order(placeOf(as(rows[1].button)))).toEqual(["two button", "two form", "two row", "list", "main"]);
  });

  it("goes to what took a gone row's place, else to the row before, else to the list", () => {
    const { rows } = page();
    const place = placeOf(as(rows[1].button));
    rows[1].row.remove();
    expect(order(place)).toEqual(["three row", "one row", "list", "main"]);
  });

  it("goes to the row before when the last row is gone", () => {
    const { rows } = page();
    const place = placeOf(as(rows[2].button));
    rows[2].row.remove();
    expect(order(place)).toEqual(["two row", "list", "main"]);
  });

  it("goes to what replaced an empty state (the first category)", () => {
    const { main, list, rows } = page();
    const place = placeOf(as(rows[0].button));
    list.remove();
    main.append(new Node("categories"));
    expect(order(place)).toEqual(["categories", "main"]);
  });

  it("stays inside the row when only its form is gone (Seat became Finish)", () => {
    const { rows } = page();
    const place = placeOf(as(rows[1].button));
    rows[1].row.children[0].remove();
    rows[1].row.append(new Node("finish form"));
    expect(order(place)).toEqual(["finish form", "two row", "list", "main"]);
  });

  it("goes nowhere when the whole page is gone", () => {
    const { main, rows } = page();
    const place = placeOf(as(rows[1].button));
    main.remove();
    expect(order(place)).toEqual([]);
  });
});

describe("whether focus was lost", () => {
  const { body, rows } = page();
  const lost = (active: Node | null) =>
    focusLost(active && as(active), as(body));

  it("is when it fell to the body, or to a control that is disabled or gone", () => {
    expect(lost(null)).toBe(true);
    expect(lost(body)).toBe(true);
    const off = new Node("off");
    rows[0].row.append(off);
    off.disabled = true;
    expect(lost(off)).toBe(true);
    expect(lost(new Node("gone"))).toBe(true);
  });

  it("isn't when the person has moved on to another control, which keeps it", () => {
    expect(lost(rows[2].button)).toBe(false);
  });
});
