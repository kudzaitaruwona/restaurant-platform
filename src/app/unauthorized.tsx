import Link from "next/link";

/** What unauthorized() shows: on /dashboard, usually a session that has ended. */
export default function Unauthorized() {
  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col gap-4 px-4 py-12">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        You&apos;re signed out
      </h1>
      <Link href="/login" className="underline">
        Sign in
      </Link>
    </main>
  );
}
