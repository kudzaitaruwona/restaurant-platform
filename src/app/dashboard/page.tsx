import { Suspense } from "react";
import { devAuthBypassEnabled } from "@/lib/env";
import { Dashboard } from "./dashboard";
import { DevSwitcher } from "./dev-switcher";
import { SignOutButton } from "./sign-out-button";

export default function DashboardPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <Dashboard />
      </Suspense>
      {devAuthBypassEnabled() ? <DevSwitcher /> : <SignOutButton />}
    </main>
  );
}
