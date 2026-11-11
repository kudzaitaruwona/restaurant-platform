import { describe, expect, it } from "vitest";
import { inviteStatus } from "./invite-status";

/** 14:05 in Harare is 12:05 UTC. */
const at = new Date("2026-11-12T12:05:00Z");
const harare = "Africa/Harare";

describe("inviteStatus (S-42)", () => {
  it("is Joined, with the day, once they've signed in", () => {
    expect(
      inviteStatus({ firstSignedInAt: at, invite: { sentAt: at, delivered: true } }, harare),
    ).toEqual({ kind: "joined", label: "Joined 12 Nov" });
  });

  it("is Invited, with when in the restaurant's timezone, until then", () => {
    expect(
      inviteStatus({ firstSignedInAt: null, invite: { sentAt: at, delivered: true } }, harare),
    ).toEqual({ kind: "invited", label: "Invited 12 Nov, 14:05" });
    expect(
      inviteStatus({ firstSignedInAt: null, invite: { sentAt: at, delivered: true } }, "UTC").label,
    ).toBe("Invited 12 Nov, 12:05");
  });

  it("counts an invite still being sent as invited", () => {
    expect(
      inviteStatus({ firstSignedInAt: null, invite: { sentAt: at, delivered: null } }, harare).kind,
    ).toBe("invited");
  });

  it("says when the latest invite didn't go", () => {
    expect(
      inviteStatus({ firstSignedInAt: null, invite: { sentAt: at, delivered: false } }, harare),
    ).toEqual({ kind: "not_sent", label: "Invite email didn't go" });
  });

  it("says when no invite was ever sent", () => {
    expect(inviteStatus({ firstSignedInAt: null, invite: null }, harare)).toEqual({
      kind: "not_invited",
      label: "Not invited yet",
    });
  });

  it("uses no dashes", () => {
    for (const label of [
      inviteStatus({ firstSignedInAt: at, invite: null }, harare).label,
      inviteStatus({ firstSignedInAt: null, invite: { sentAt: at, delivered: true } }, harare).label,
    ]) {
      expect(label).not.toMatch(/[–—]/);
    }
  });
});
