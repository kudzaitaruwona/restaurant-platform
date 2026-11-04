import type { Metadata } from "next";
import { Suspense } from "react";
import { SignInForm } from "../sign-in-form";

export const metadata: Metadata = { title: "Platform admin sign-in" };

/** Not under /admin: nothing here may sit behind the admin guard it leads to. */
export default function AdminLoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-6 px-4 py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        Platform admin sign-in
      </h1>
      <Suspense>
        <SignInForm audience="admin" destination="/admin" page="/login/admin" />
      </Suspense>
    </main>
  );
}
