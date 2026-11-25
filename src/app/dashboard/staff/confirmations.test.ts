import { describe, expect, it } from "vitest";
import { deactivateConfirmation, roleConfirmation } from "./confirmations";

describe("the staff screen's confirmations", () => {
  it("tells you that demoting yourself costs you access", () => {
    const c = roleConfirmation({ displayName: "Tendai", role: "owner", you: true });
    expect(c.title).toBe("Make yourself staff?");
    expect(c.description).toMatch(/You'll lose access/);
    expect(c.tone).toBe("danger");
  });

  it("confirms role changes on others, both ways", () => {
    expect(roleConfirmation({ displayName: "Rudo", role: "staff", you: false }).title).toBe(
      "Make Rudo an owner?",
    );
    const demote = roleConfirmation({ displayName: "Rudo", role: "owner", you: false });
    expect(demote.title).toBe("Make Rudo staff?");
    expect(demote.description).toMatch(/^They'll lose access/);
  });

  it("addresses you when you deactivate yourself", () => {
    expect(deactivateConfirmation({ displayName: "Tendai", you: true }).description).toBe(
      "You won't be able to sign in.",
    );
    expect(deactivateConfirmation({ displayName: "Rudo", you: false }).description).toBe(
      "They won't be able to sign in.",
    );
  });
});
