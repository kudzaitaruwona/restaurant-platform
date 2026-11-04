import { and, asc, eq } from "drizzle-orm";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { restaurants, staff } from "@/db/schema";
import { getTenantContext, withTenant } from "@/lib/tenant";

/** The current restaurant and identity, and the example owner-only action. */
export async function Dashboard() {
  const tenant = await getTenantContext();
  const { restaurant, team } = await withTenant(tenant, async (tx) => {
    const [restaurant] = await tx
      .select({ name: restaurants.name })
      .from(restaurants)
      .where(eq(restaurants.id, tenant.restaurantId));
    const team = await tx
      .select({
        id: staff.id,
        displayName: staff.displayName,
        role: staff.role,
      })
      .from(staff)
      .where(and(eq(staff.restaurantId, tenant.restaurantId), eq(staff.active, true)))
      .orderBy(asc(staff.createdAt), asc(staff.id));
    return { restaurant, team };
  });

  const me = team.find((member) => member.id === tenant.staffId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">
          {restaurant.name}
        </h1>
        <p className="text-muted-foreground">
          Signed in as {me?.displayName} ({tenant.role})
        </p>
        {tenant.role === "owner" && (
          <nav className="mt-2 flex gap-4 text-sm underline">
            <Link href="/dashboard/menu">Menu</Link>
            <Link href="/dashboard/settings">Restaurant settings</Link>
            <Link href="/dashboard/staff">Staff</Link>
          </nav>
        )}
      </div>
      <ul className="flex flex-col gap-3">
        {team.map((member) => (
          <li key={member.id} className="flex flex-col gap-1">
            <span>
              {member.displayName}{" "}
              <span className="text-sm text-muted-foreground">
                {member.role}
              </span>
            </span>
            {tenant.role === "owner" && (
              <form
                method="post"
                action={`/api/staff/${member.id}`}
                className="flex gap-2"
              >
                <input
                  name="displayName"
                  defaultValue={member.displayName}
                  aria-label={`New name for ${member.displayName}`}
                  required
                  maxLength={200}
                  className="min-w-0 flex-1 rounded-md border px-2 py-1 text-sm"
                />
                <Button type="submit" variant="outline" size="sm">
                  Rename
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
