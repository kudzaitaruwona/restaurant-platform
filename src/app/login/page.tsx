import { Mail } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";
import { StatusPage } from "../status-page";
import { SignIn } from "./sign-in";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <StatusPage
      icon={<Mail strokeWidth={1.75} />}
      title="Sign in"
      actions={
        <Suspense>
          <SignIn audience="staff" searchParams={searchParams} />
        </Suspense>
      }
    >
      We&apos;ll email you a sign-in link or a code.
    </StatusPage>
  );
}
