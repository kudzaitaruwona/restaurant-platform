/**
 * Invited or Joined (S-42), as the staff screen and the owner card on /admin
 * both say it. Times are in the restaurant's timezone, never the server's.
 */
export type InviteState = {
  firstSignedInAt: Date | null;
  invite: { sentAt: Date; delivered: boolean | null } | null;
};

export type InviteStatus = {
  /** `not_sent`: the latest invite failed; `not_invited`: none was ever sent. */
  kind: "joined" | "invited" | "not_sent" | "not_invited";
  label: string;
};

const day = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone }).format(at);

const time = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);

export function inviteStatus(person: InviteState, timeZone: string): InviteStatus {
  if (person.firstSignedInAt) {
    return { kind: "joined", label: `Joined ${day(person.firstSignedInAt, timeZone)}` };
  }
  const { invite } = person;
  if (!invite) return { kind: "not_invited", label: "Not invited yet" };
  if (invite.delivered === false) return { kind: "not_sent", label: "Invite email didn't go" };
  return {
    kind: "invited",
    label: `Invited ${day(invite.sentAt, timeZone)}, ${time(invite.sentAt, timeZone)}`,
  };
}
