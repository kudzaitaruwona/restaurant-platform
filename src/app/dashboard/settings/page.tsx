import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsScreen } from "./settings-screen";

export const metadata: Metadata = { title: "Restaurant settings" };

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-ink-2">Loading…</p>}>
      <SettingsScreen />
    </Suspense>
  );
}
