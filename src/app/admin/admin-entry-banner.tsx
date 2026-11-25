import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { enteredRestaurant } from "@/lib/tenant/admin-entry";
import { getPlatformAdminContext, listRestaurants } from "@/lib/tenant/platform-admin";

/**
 * Says so on /admin while this session is inside a restaurant (spec 01), the way
 * the bar on the staff screens does, with the same Leave. Otherwise an admin who
 * went back to the list has no sign that they are still acting as a restaurant's
 * owner. A plain form, so leaving lands back here.
 */
export async function AdminEntryBanner() {
  const admin = await getPlatformAdminContext();
  const entry = await enteredRestaurant(admin.sessionId);
  if (!entry) return null;
  const restaurant = (await listRestaurants(admin)).find(({ id }) => id === entry.restaurantId);
  if (!restaurant) return null;

  return (
    <div
      role="status"
      data-admin-bar
      className="sticky top-0 z-50 flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 bg-ink py-1 pr-2 pl-4 text-caption font-medium text-page md:pl-5 md:text-body"
    >
      <p className="min-w-0 truncate">Acting as admin in {restaurant.name}</p>
      <div className="flex items-center gap-2">
        <Link
          href="/dashboard"
          className={cn(
            buttonVariants({ variant: "ghost", size: "compact" }),
            "h-9 border-page/40 text-caption text-page hover:bg-page/15",
          )}
        >
          Back to {restaurant.name}
          <ArrowRight aria-hidden strokeWidth={1.75} />
        </Link>
        <form method="post" action="/api/admin/leave">
          <Button
            type="submit"
            variant="ghost"
            size="compact"
            className="h-9 border-page/40 text-caption text-page hover:bg-page/15"
          >
            Leave restaurant
          </Button>
        </form>
      </div>
    </div>
  );
}
