import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyMessage } from "./copy-message";
import { slugFrom } from "./new-restaurant-sheet";
import { ownerSignInMessage } from "./sign-in-message";

describe("the owner's sign-in message", () => {
  it("names the restaurant, the sign-in page and their email, and says there's no password", () => {
    expect(
      ownerSignInMessage({
        restaurantName: "Chikurubi Kitchen",
        appUrl: "https://app.example",
        ownerName: "Tariro Mupfumira",
        ownerEmail: "tariro@chikurubikitchen.co.zw",
      }),
    ).toBe(
      "Hi Tariro, Chikurubi Kitchen is ready for you. Sign in at https://app.example/login " +
        "with tariro@chikurubikitchen.co.zw. You will get a sign-in link or a code by email. " +
        "There is no password.",
    );
  });

  it("works from the restaurant alone when the owner's details aren't on the page", () => {
    expect(ownerSignInMessage({ restaurantName: "Msasa Grill", appUrl: "http://localhost:3000/" })).toBe(
      "Hi, Msasa Grill is ready for you. Sign in at http://localhost:3000/login with the email " +
        "address you gave us. You will get a sign-in link or a code by email. There is no password.",
    );
  });

  it("is plain text for the clipboard: a name with markup stays as typed", () => {
    const text = ownerSignInMessage({
      restaurantName: `<img src=x onerror=alert(1)> "Tom & Jerry's"`,
      appUrl: "https://app.example",
    });
    expect(text).toContain(`<img src=x onerror=alert(1)> "Tom & Jerry's" is ready`);
    expect(text).not.toContain("&amp;");
  });

  it("has no em or en dashes", () => {
    expect(ownerSignInMessage({ restaurantName: "A", appUrl: "https://a.example" })).not.toMatch(/[–—]/);
  });
});

describe("the copy box", () => {
  it("shows the message escaped, with a copy button described by it", () => {
    const html = renderToStaticMarkup(<CopyMessage text={`Hi, <b>"Tom & Jerry's"</b> is ready`} />);
    expect(html).toContain("Hi, &lt;b&gt;&quot;Tom &amp; Jerry&#x27;s&quot;&lt;/b&gt; is ready");
    expect(html).not.toContain("<b>");
    const id = /<p id="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(new RegExp(`<button[^>]*type="button"[^>]*aria-describedby="${id}"`));
    expect(html).toContain("Copy message for WhatsApp");
  });
});

describe("the public address from the name", () => {
  it.each([
    ["Chikurubi Kitchen", "chikurubi-kitchen"],
    ["  Mama's  Café & Grill ", "mama-s-cafe-grill"],
    ["!!!", ""],
    ["a".repeat(70), "a".repeat(63)],
  ])("%s becomes %s", (name, slug) => {
    expect(slugFrom(name)).toBe(slug);
    expect(slug).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
  });
});
