import { ShieldCheck } from "lucide-react";
import { Suspense } from "react";
import { devAuthBypassEnabled } from "@/lib/env";
import { DevSwitcher } from "../dashboard/dev-switcher";
import { SignOutButton } from "../dashboard/sign-out-button";
import { AdminConsole } from "./admin-console";

/**
 * The account controls are built for the staff rail; here they sit at the top
 * right, so the switcher's list and sign-out's error open below them instead.
 */
const accountSlot =
  "relative w-44 shrink-0 sm:w-48 [&_details]:m-0 [&_details>form]:absolute [&_details>form]:top-full [&_details>form]:right-0 [&_details>form]:z-20 [&_details>form]:mt-1 [&_details>form]:w-64 [&_details>form]:rounded-control [&_details>form]:border [&_details>form]:border-line [&_details>form]:bg-surface [&_details>form]:p-2 [&_details>form]:shadow-float [&>div]:m-0 [&_[role=alert]]:absolute! [&_[role=alert]]:top-full! [&_[role=alert]]:right-0! [&_[role=alert]]:bottom-auto! [&_[role=alert]]:left-auto! [&_[role=alert]]:z-20 [&_[role=alert]]:mt-1! [&_[role=alert]]:ml-0! [&_[role=alert]]:w-64 [&_[role=alert]]:shadow-float";

export default function AdminPage() {
  return (
    <div className="flex w-full flex-1 flex-col bg-page">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between gap-4 px-4 md:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="grid size-10 shrink-0 place-items-center rounded-control bg-brand text-brand-ink"
            >
              <ShieldCheck className="size-5" strokeWidth={1.75} />
            </span>
            <span className="hidden truncate text-body font-semibold sm:block">restaurant-platform</span>
          </div>
          <div className={accountSlot}>
            {devAuthBypassEnabled() ? <DevSwitcher /> : <SignOutButton audience="admin" />}
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pt-5 pb-8 md:px-8 md:pt-8">
        <Suspense fallback={<p className="text-body text-ink-2">Loading…</p>}>
          <AdminConsole />
        </Suspense>
      </main>
    </div>
  );
}
