import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pressable } from "./motion";

export default function Home() {
  return (
    <main className="flex w-full flex-1 flex-col bg-page px-4">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-8 py-24">
        <div className="flex flex-col gap-3">
          <h1 className="text-display font-semibold tracking-[-0.02em] text-ink">
            restaurant-platform
          </h1>
          <p className="max-w-[46ch] text-lead text-ink-2">
            Menus, autonomous bookings and QR ordering for sit-down restaurants.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            nativeButton={false}
            render={
              <a href="https://github.com/kudzaitaruwona/restaurant-platform" />
            }
          >
            View the project
            <ArrowUpRight aria-hidden strokeWidth={1.75} />
          </Button>
          <Link href="/login" className={cn(buttonVariants({ variant: "secondary" }), pressable)}>
            Staff sign-in
          </Link>
        </div>
      </div>
    </main>
  );
}
