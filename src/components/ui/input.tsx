import { ChevronDown } from "lucide-react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * The control style (S-41): 48px tall, 10px radius, hairline border on the
 * surface, a green focus ring, and text-control: 16px on small screens, so iOS
 * doesn't zoom in on focus, body size from md up. Use it on any raw <input>, <select> or
 * <textarea>, or use the components below.
 */
export const inputClassName =
  "min-h-12 w-full min-w-0 rounded-control border border-line bg-surface px-3 py-2.5 text-control text-ink placeholder:text-ink-2 outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger [&[type=number]]:tabular-nums";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputClassName, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(inputClassName, "min-h-24 resize-y", className)} {...props} />;
}

/** A native select with the system's chevron. `className` goes on the wrapper. */
export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <span className={cn("relative inline-flex w-full min-w-0", className)}>
      <select className={cn(inputClassName, "appearance-none pr-10")} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 size-5 -translate-y-1/2 text-ink-2"
      />
    </span>
  );
}

/**
 * A label above its control, with an optional hint and, when it's refused, why, below.
 * The refusal is outside the label, so it isn't read as part of the control's name:
 * a field that can be refused gives an `errorId` always, and its control carries
 * aria-invalid and an aria-describedby of it while it is.
 */
export function Field({
  label,
  hint,
  error,
  errorId,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
} & ({ error?: undefined; errorId?: undefined } | { error: ReactNode; errorId: string })) {
  const field = (
    <label
      className={cn(
        "flex flex-col gap-1.5 text-caption font-medium text-ink-2",
        errorId === undefined && className,
      )}
    >
      {label}
      {children}
      {hint && <span className="font-normal text-ink-2">{hint}</span>}
    </label>
  );
  if (errorId === undefined) return field;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {field}
      {error && (
        <span id={errorId} role="alert" className="text-caption font-normal text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
