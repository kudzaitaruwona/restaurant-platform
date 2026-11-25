import { Suspense } from "react";
import { APP_NAME } from "@/lib/auth/email";
import { StaffSignIn, StartLink } from "./start-link";

export default function Home() {
  return (
    <main className="flex w-full flex-1 flex-col bg-page px-4">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-8 py-24">
        <div className="flex flex-col gap-3">
          <h1 className="text-display font-semibold tracking-[-0.02em] text-ink">{APP_NAME}</h1>
          <p className="max-w-[46ch] text-lead text-ink-2">
            Menus, table bookings and QR ordering for sit-down restaurants. Guests see your menu
            and book on their phone, and your team runs the service in one place.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Suspense fallback={<StaffSignIn />}>
            <StartLink />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
