import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "attention" | "danger" | "positive";

const tones: Record<Tone, { className: string; icon: ReactNode }> = {
  neutral: { className: "bg-surface-2 [&>svg]:text-ink-2", icon: <Info /> },
  attention: { className: "bg-attention-soft [&>svg]:text-attention", icon: <TriangleAlert /> },
  danger: { className: "bg-danger-soft [&>svg]:text-danger", icon: <CircleAlert /> },
  positive: { className: "bg-accent-soft [&>svg]:text-accent", icon: <CircleCheck /> },
};

/**
 * A message in place (S-41), never floating over content. Neutral informs;
 * attention means a person must act (amber); danger is for a failed or
 * destructive outcome; positive confirms. Text stays ink for contrast; the
 * icon carries the tone. Pass role="alert" or role="status" as the case needs.
 */
export function Notice({
  tone = "neutral",
  title,
  icon,
  className,
  children,
  ...props
}: {
  tone?: Tone;
  title?: ReactNode;
  /** Replaces the tone's icon; pass `null` for none. */
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  const look = tones[tone];
  return (
    <div
      data-tone={tone}
      className={cn(
        "flex items-start gap-3 rounded-control px-4 py-3 text-body text-ink [&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0",
        look.className,
        className,
      )}
      {...props}
    >
      {icon === undefined ? look.icon : icon}
      <div className="flex min-w-0 flex-col gap-0.5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}
