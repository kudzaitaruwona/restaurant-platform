import { Button } from "@/components/ui/button";
import { devAuthBypassEnabled } from "@/lib/env";
import { devSwitcherIdentities } from "@/lib/tenant/dev-identities";

/** Swaps between the seeded identities (S-25). Absent unless the bypass is on. */
export function DevSwitcher() {
  if (!devAuthBypassEnabled()) return null;

  return (
    <form
      method="post"
      action="/api/dev/identity"
      className="flex flex-col gap-2 border-t pt-4"
    >
      <p className="text-sm text-muted-foreground">Dev switcher: act as</p>
      <div className="flex flex-wrap gap-2">
        {devSwitcherIdentities.map(({ key, label }) => (
          <Button
            key={key}
            type="submit"
            name="identity"
            value={key}
            variant="outline"
            size="sm"
          >
            {label}
          </Button>
        ))}
      </div>
    </form>
  );
}
