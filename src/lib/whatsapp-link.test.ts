import { describe, expect, it } from "vitest";
import { whatsappLink } from "./whatsapp-link";

describe("the WhatsApp click-to-chat link", () => {
  it("is wa.me with the number's digits, no plus", () => {
    expect(whatsappLink("+263771234567")).toBe("https://wa.me/263771234567");
  });

  it.each([
    ["no number", null],
    ["an empty one", ""],
    ["a local number with no country code", "0771234567"],
    ["a number too short to be reached", "+12345"],
    ["text that would break out of the path", "+263771234567/../../x?text=hi"],
    ["a space or a query", "+263771234567 ?a=b"],
    ["a number with a NUL", "+263771234567\0"],
    ["a newline at the end, which $ would let through", "+263771234567\n"],
  ])("gives no link for %s", (_name, phone) => {
    expect(whatsappLink(phone)).toBeUndefined();
  });
});
