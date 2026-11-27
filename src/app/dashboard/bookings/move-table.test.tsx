import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { MoveTableDialog } from "./move-table";

describe("the move-table rows (#94)", () => {
  const html = renderToStaticMarkup(
    <MoveTableDialog
      id="move-1"
      bookingId="b1"
      guestName="Ana"
      summary="19:00, party of 4"
      table="T1"
      moves={[{ id: "t2", label: "x".repeat(50), capacity: 4, walkInOnly: true }]}
    />,
  );
  const classesOf = (text: string) =>
    new RegExp(`<span class="([^"]*)">${text}`).exec(html)![1].split(" ");

  it("never splits the seats hint beside a long label", () => {
    expect(classesOf("seats 4")).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
  });
});
