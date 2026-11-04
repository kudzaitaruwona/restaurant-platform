import { type ReactNode, Suspense } from "react";
import { ActingAsAdminBanner } from "./acting-as-admin-banner";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense>
        <ActingAsAdminBanner />
      </Suspense>
      {children}
    </>
  );
}
