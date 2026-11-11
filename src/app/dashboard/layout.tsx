import { type ReactNode, Suspense } from "react";
import { ActingAsAdminBanner } from "./acting-as-admin-banner";
import { StaffNav, StaffNavPlaceholder } from "./shell/staff-shell";

/**
 * The staff shell (S-41) around every /dashboard page: the acting-as-admin bar
 * across the top, the navigation rail (a top bar on phones), and the page.
 * The shell pads the page (20px 32px 32px; 12px 16px 24px on phones), so pages
 * don't add outer padding of their own. A page that wants dark, whatever the
 * system says, renders an element with data-page-theme="dark" (globals.css).
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div
      data-staff-shell
      className="flex min-h-dvh flex-1 flex-col bg-page text-body text-ink [--admin-bar:0px] has-[[data-admin-bar]]:[--admin-bar:44px]"
    >
      <Suspense>
        <ActingAsAdminBanner />
      </Suspense>
      <div className="flex-1 md:grid md:grid-cols-[64px_minmax(0,1fr)]">
        <Suspense fallback={<StaffNavPlaceholder />}>
          <StaffNav />
        </Suspense>
        <div className="min-w-0 px-4 pt-3 pb-6 md:px-8 md:pt-5 md:pb-8 print:p-0">{children}</div>
      </div>
    </div>
  );
}
