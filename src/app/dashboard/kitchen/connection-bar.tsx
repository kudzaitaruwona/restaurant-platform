import { LogOut, WifiOff } from "lucide-react";
import type { Connection } from "@/lib/kitchen-poll";

/**
 * Says the board isn't live (spec 07). It covers what is at the top of the screen
 * instead of pushing the board down, so the network going can't slide another row
 * under a finger (#135). Its place takes no height (-mb-4 cancels the board's gap
 * after it) and stays when there is nothing to say. Below the phone's top bar and
 * the acting-as-admin bar, which stick to the top too.
 */
export function ConnectionBar({ connection }: { connection: Connection }) {
  return (
    <div
      role="alert"
      className="sticky top-[calc(var(--admin-bar)+3.5rem)] z-10 -mb-4 h-0 md:top-[var(--admin-bar)]"
    >
      {connection !== "online" && (
        <div className="absolute inset-x-0 top-0 flex items-center gap-3 rounded-control bg-attention px-5 py-3 text-[1.25em] font-semibold text-on-attention shadow-float">
          {connection === "offline" ? (
            <WifiOff aria-hidden className="size-[1.2em] shrink-0" />
          ) : (
            <LogOut aria-hidden className="size-[1.2em] shrink-0" />
          )}
          {connection === "offline"
            ? "Offline, reconnecting. The board may be out of date."
            : "Signed out. Sign in again to keep the board live."}
        </div>
      )}
    </div>
  );
}
