import { Mail } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { StatusPage } from "../status-page";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <StatusPage
      icon={<Mail strokeWidth={1.75} />}
      title="Sign in"
      actions={
        <Suspense>
          <SignInForm audience="staff" destination="/dashboard" page="/login" />
        </Suspense>
      }
    >
      We&apos;ll email you a sign-in link or a code.
    </StatusPage>
  );
}
