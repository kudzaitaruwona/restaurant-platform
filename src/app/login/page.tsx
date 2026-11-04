import type { Metadata } from "next";
import { Suspense } from "react";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-4 py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Sign in
      </h1>
      <Suspense>
        <SignInForm audience="staff" destination="/dashboard" page="/login" />
      </Suspense>
    </main>
  );
}
