import { redirect } from "next/navigation";
import type { Audience } from "@/lib/auth";
import { returnPath, signInDefaults, signInPageFor } from "@/lib/auth/return-to";
import { signedInEmail } from "@/lib/tenant";
import { SignInForm } from "./sign-in-form";

type Query = Record<string, string | string[] | undefined>;

/**
 * The form, or straight on for someone this session type already knows: a
 * reopened link lands here too, and they're in. An invite for somebody else
 * (S-42) still gets the form, so a shared tablet can change hands.
 */
export async function SignIn({
  audience,
  searchParams,
}: {
  audience: Audience;
  searchParams: Promise<Query>;
}) {
  const { next, email: invited } = await searchParams;
  const destination = returnPath(next, audience) ?? signInDefaults[audience];
  const email = await signedInEmail(audience);
  const forSomeoneElse =
    typeof invited === "string" && invited.trim().toLowerCase() !== email?.toLowerCase();
  if (email && !forSomeoneElse) redirect(destination);

  return (
    <SignInForm
      audience={audience}
      destination={destination}
      page={signInPageFor(audience, destination)}
    />
  );
}
