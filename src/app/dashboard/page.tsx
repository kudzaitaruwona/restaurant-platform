import type { Metadata } from "next";
import { Suspense } from "react";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = { title: "Home" };

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-body text-ink-2">Loading…</p>}>
      <Dashboard />
    </Suspense>
  );
}
