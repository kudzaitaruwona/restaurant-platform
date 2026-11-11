"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Audience = "staff" | "admin";

/**
 * Sign-out is a POST, and Better Auth answers it with JSON, so not a plain form.
 * Goes to the sign-in page only if the session really ended: on a shared tablet,
 * a login page over a live session is worse than an error. Returns what went
 * wrong, if anything.
 */
export async function signOut(audience: Audience, go: (page: string) => void) {
  try {
    const response = await fetch(`/api/auth/${audience}/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) return "That didn't work, so you're still signed in. Try again.";
  } catch {
    return "We couldn't reach the server, so you may still be signed in. Try again.";
  }
  go(audience === "admin" ? "/login/admin" : "/login");
}

export function SignOutButton({ audience }: { audience: Audience }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function click() {
    setPending(true);
    setProblem(undefined);
    const failure = await signOut(audience, (page) => router.replace(page));
    if (!failure) return; // stays pending until the sign-in page replaces this one
    setProblem(failure);
    setPending(false);
  }

  return (
    <div className="relative mx-2 mt-1">
      <button
        type="button"
        disabled={pending}
        onClick={click}
        className="flex h-12 w-full items-center gap-3.5 rounded-control px-3 text-body font-medium text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <LogOut aria-hidden className="size-[22px] shrink-0" strokeWidth={1.75} />
        <span className="rail-fade">{pending ? "Signing out…" : "Sign out"}</span>
      </button>
      {problem && (
        // In the rail's footer, which clips anything beside it: not faded with
        // the labels, and the rail stays open (globals.css) while it shows.
        <p
          role="alert"
          className="mt-1 rounded-control bg-danger-soft p-3 text-caption whitespace-normal text-ink"
        >
          {problem}
        </p>
      )}
    </div>
  );
}
