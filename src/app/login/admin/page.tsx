import { ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { StatusPage } from "../../status-page";
import { SignIn } from "../sign-in";

export const metadata: Metadata = { title: "Platform admin sign-in" };

/** Not under /admin: nothing here may sit behind the admin guard it leads to. */
export default function AdminLoginPage({ searchParams }: PageProps<"/login/admin">) {
  return (
    <StatusPage
      icon={<ShieldCheck strokeWidth={1.75} />}
      title="Platform admin sign-in"
      actions={
        <Suspense>
          <SignIn audience="admin" searchParams={searchParams} />
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
