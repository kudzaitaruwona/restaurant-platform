import { Suspense } from "react";
import { SettingsScreen } from "./settings-screen";

export default function Page() {
  return (
    <Suspense fallback={<p className="text-body text-ink-2">Loading…</p>}>
      <SettingsScreen />
    </Suspense>
  );
}
