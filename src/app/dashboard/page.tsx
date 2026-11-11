import { Suspense } from "react";
import { Dashboard } from "./dashboard";

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-body text-ink-2">Loading…</p>}>
      <Dashboard />
    </Suspense>
  );
}
