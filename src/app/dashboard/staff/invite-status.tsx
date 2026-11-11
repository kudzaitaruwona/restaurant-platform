import { CircleCheck, Mail, MailWarning } from "lucide-react";
import type { InviteStatus } from "@/lib/invite-status";
import { cn } from "@/lib/utils";

/**
 * Invited or Joined (S-42), as a quiet caption with an icon, so none of it
 * relies on colour: green for joined, amber where a person needs to look (the
 * invite didn't go), grey otherwise (S-41). On the staff screen and /admin.
 */
export function InviteStatusLabel({
  status,
  className,
}: {
  status: InviteStatus;
  className?: string;
}) {
  const Icon =
    status.kind === "joined" ? CircleCheck : status.kind === "not_sent" ? MailWarning : Mail;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-caption tabular-nums",
        status.kind === "joined" && "text-ink-2 [&_svg]:text-accent",
        status.kind === "not_sent" && "font-medium text-attention-ink [&_svg]:text-attention",
        (status.kind === "invited" || status.kind === "not_invited") && "text-ink-2",
        className,
      )}
    >
      <Icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
      {status.label}
    </span>
  );
}
