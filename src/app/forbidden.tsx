import { ShieldX } from "lucide-react";
import { Suspense } from "react";
import { StatusPage } from "./status-page";
import { NoAccessLink, NoAccessReason } from "./way-out";

/**
 * What forbidden() shows outside the staff shell: restaurant staff on /admin, or
 * a platform admin on /dashboard who hasn't entered a restaurant, if they weren't
 * sent on to /admin (noTenantForAdmin). An owner-only refusal of a staff page is
 * dashboard/forbidden.tsx, which keeps the shell.
 */
export default function Forbidden() {
  return (
    <StatusPage
      icon={<ShieldX strokeWidth={1.75} />}
      title="You can't open this page"
      actions={
        <Suspense>
          <NoAccessLink />
        </Suspense>
      }
    >
      <Suspense>
        <NoAccessReason />
      </Suspense>
    </StatusPage>
  );
}
