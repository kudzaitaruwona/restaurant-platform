import type { ReactNode } from "react";

export const inputClassName =
  "w-full min-w-0 rounded-md border bg-background px-2 py-1.5 text-sm";

/** A label above its control, with an optional hint below. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
      {hint && (
        <span className="font-normal text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}
