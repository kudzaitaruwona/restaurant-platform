import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { signedInHome } from "@/lib/tenant";
import { cn } from "@/lib/utils";
import { pressable } from "./motion";

const button = cn(buttonVariants({ size: "staff" }), pressable);

export function StaffSignIn() {
  return (
    <Link href="/login" className={button}>
      Staff sign-in
    </Link>
  );
}

/** Staff sign-in, or the way back in for someone already signed in. */
export async function StartLink() {
  const home = await signedInHome();
  if (!home) return <StaffSignIn />;
  return (
    <Link href={home} className={button}>
      {home === "/admin" ? "Open the admin console" : "Open your dashboard"}
    </Link>
  );
}
