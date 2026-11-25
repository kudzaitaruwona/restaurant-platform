import { describe, expect, it, vi } from "vitest";
import { confirmationNeeded } from "./confirm-response";
import { FORM_FETCH_HEADER } from "./form-response";

const requestFor = (fetched: boolean) =>
  new Request("http://localhost:3000/api/menu/items/abc", {
    method: "POST",
    headers: fetched ? { [FORM_FETCH_HEADER]: "1" } : {},
  });
const formOf = (fields: [string, string][]) => {
  const form = new FormData();
  for (const [name, value] of fields) form.append(name, value);
  return form;
};

describe("a confirmed repost", () => {
  it("never runs the warning queries", async () => {
    const warnings = vi.fn(async () => ["Asked."]);
    const answer = await confirmationNeeded(requestFor(true), formOf([["confirmed", "1"]]), "/dashboard/menu", warnings);
    expect(answer).toBeNull();
    expect(warnings).not.toHaveBeenCalled();
  });

  it("is asked nothing when there is nothing to ask", async () => {
    expect(await confirmationNeeded(requestFor(false), formOf([]), "/dashboard/menu", () => [])).toBeNull();
  });
});

describe("a warning", () => {
  it("is 409 JSON for the form's own fetch", async () => {
    const answer = await confirmationNeeded(requestFor(true), formOf([]), "/dashboard/menu", () => ["A.", "B."]);
    expect(answer?.status).toBe(409);
    expect(await answer?.json()).toEqual({ error: "A. B.", confirm: { warnings: ["A.", "B."] } });
  });

  it("is a page with a way to confirm for a plain post, echoing the form escaped", async () => {
    const answer = await confirmationNeeded(
      requestFor(false),
      formOf([
        ["name", `"><script>alert(1)</script>`],
        ["priceUsd", "0"],
        ["priceUsd", "0"],
        ["confirmed", "0"],
      ]),
      "/dashboard/menu",
      () => ["The USD price is 0, so this item would be free."],
    );
    expect(answer?.status).toBe(409);
    expect(answer?.headers.get("content-type")).toContain("text/html");
    const page = await answer!.text();
    expect(page).toContain("The USD price is 0, so this item would be free.");
    expect(page).toContain(`<form method="post" action="/api/menu/items/abc"`);
    expect(page).toContain(`name="name" value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`);
    expect(page).not.toContain("<script>");
    expect(page.match(/name="priceUsd" value="0"/g)).toHaveLength(2);
    expect(page.match(/name="confirmed"/g)).toHaveLength(1);
    expect(page).toContain(`name="confirmed" value="1"`);
    expect(page).toContain("Save anyway");
    expect(page).toContain(`<a href="/dashboard/menu">Go back</a>`);
  });
});
