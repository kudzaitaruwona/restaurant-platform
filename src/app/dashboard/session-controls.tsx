import { devAuthBypassEnabled } from "@/lib/env";
import { getTenantContext } from "@/lib/tenant";
import { DevSwitcher } from "./dev-switcher";
import { SignOutButton } from "./sign-out-button";

/** Signing out ends whichever session is in use, which may be the admin's. */
export async function SessionControls() {
  if (devAuthBypassEnabled()) return <DevSwitcher />;

  const { platformAdminId } = await getTenantContext();
  return <SignOutButton audience={platformAdminId ? "admin" : "staff"} />;
}
