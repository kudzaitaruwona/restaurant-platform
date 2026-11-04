import { Suspense } from "react";
import { devAuthBypassEnabled } from "@/lib/env";
import { DevSwitcher } from "../dashboard/dev-switcher";
import { SignOutButton } from "../dashboard/sign-out-button";
import { AdminConsole } from "./admin-console";

export default function AdminPage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-12">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <AdminConsole />
      </Suspense>
      {devAuthBypassEnabled() ? <DevSwitcher /> : <SignOutButton audience="admin" />}
    </main>
  );
}
