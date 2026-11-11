import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { StatusPage } from "../../status-page";
import { SignInForm } from "../sign-in-form";

export const metadata: Metadata = { title: "Platform admin sign-in" };

/** Not under /admin: nothing here may sit behind the admin guard it leads to. */
export default function AdminLoginPage() {
  return (
    <StatusPage
      icon={<ShieldCheck strokeWidth={1.75} />}
      title="Platform admin sign-in"
      actions={
        <Suspense>
          <SignInForm audience="admin" destination="/admin" page="/login/admin" />
        </Suspense>
      }
      footer={
        <>
          Work at a restaurant?{" "}
          <Link href="/login" className="font-medium text-ink underline underline-offset-4">
            Staff sign-in
          </Link>
        </>
      }
    >
      For the team that runs the platform.
    </StatusPage>
  );
}
