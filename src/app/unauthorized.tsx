import { LogIn } from "lucide-react";
import { Suspense } from "react";
import { StatusPage } from "./status-page";
import { OtherSignIn, SignInLink } from "./way-out";

/** What unauthorized() shows: on /dashboard, usually a session that has ended. */
export default function Unauthorized() {
  return (
    <StatusPage
      icon={<LogIn strokeWidth={1.75} />}
      title="You're signed out"
      actions={
        <Suspense>
          <SignInLink />
        </Suspense>
      }
      footer={
        <Suspense>
          <OtherSignIn />
        </Suspense>
      }
    >
      Sign in again to carry on.
    </StatusPage>
  );
}
