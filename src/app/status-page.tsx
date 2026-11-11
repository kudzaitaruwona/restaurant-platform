import type { ReactNode } from "react";

/**
 * The calm centred page (S-41) behind sign-in, signed-out, no-access and
 * not-found: a quiet icon, a title, a line of help, then the way on. No staff
 * shell, so it reads the same to a guest who wandered in and to a waiter whose
 * session ended.
 */
export function StatusPage({
  icon,
  title,
  children,
  actions,
  footer,
}: {
  /** A Lucide icon, drawn in a soft square above the title. */
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Quiet text under the card (another way in, a hint). */
  footer?: ReactNode;
}) {
  return (
    <main className="flex w-full flex-1 flex-col items-center justify-center bg-page px-4 py-12 sm:py-20">
      <div className="flex w-full max-w-[400px] flex-col gap-4">
        <div className="flex flex-col gap-6 rounded-card border border-line bg-surface p-6 text-ink sm:p-8">
          <div className="flex flex-col gap-4">
            <span
              aria-hidden
              className="grid size-11 place-items-center rounded-control bg-surface-2 text-ink [&_svg]:size-[22px]"
            >
              {icon}
            </span>
            <div className="flex flex-col gap-1.5">
              <h1 className="text-heading font-semibold tracking-[-0.01em]">{title}</h1>
              {children && <div className="text-body text-ink-2">{children}</div>}
            </div>
          </div>
          {actions && <div className="flex flex-col gap-3">{actions}</div>}
        </div>
        {footer && <p className="text-center text-caption text-ink-2">{footer}</p>}
      </div>
    </main>
  );
}
