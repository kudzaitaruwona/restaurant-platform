import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { exchangeRates } from "@/db/schema";
import { revalidateMenu } from "@/lib/menu-cache";
import { recordAudit } from "@/lib/tenant/audit";
import {
  type TenantContext,
  type TenantTransaction,
  withTenant,
} from "@/lib/tenant/scope";

/**
 * The exchange rate (spec 02 › Exchange rate), owner only (S-26): callers check
 * requireOwner(ctx). Every change is a new exchange_rates row and an audit entry,
 * for owners too: the rate reprices every calculated ZiG price, so spec 02 asks
 * for the trail. The public menu reads the rate through latestRate, so this
 * imports the tenant scope and not "@/lib/tenant" (S-32).
 */

const message = "Enter the rate as a number above 0, like 26.2.";

const newRate = z.object({
  usdToZig: z
    .string(message)
    .trim()
    .regex(/^[0-9]{1,6}(\.[0-9]{1,6})?$/, message)
    .refine((value) => Number(value) > 0, message)
    // 26.20 and 26.2 are one rate, and the editor shows it back as typed.
    .transform((value) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value)),
});

export type NewExchangeRate = z.output<typeof newRate>;

export const parseNewExchangeRate = (form: FormData) => {
  const result = newRate.safeParse(Object.fromEntries(form));
  return result.success
    ? ({ success: true, data: result.data } as const)
    : ({ success: false, message: result.error.issues[0].message } as const);
};

export type CurrentRate = { usdToZig: string; setAt: Date };

/** The latest row, inside a transaction already scoped to the restaurant. */
export async function latestRate(
  tx: TenantTransaction,
  restaurantId: string,
): Promise<CurrentRate | null> {
  const [row] = await tx
    .select({ usdToZig: exchangeRates.usdToZig, setAt: exchangeRates.createdAt })
    .from(exchangeRates)
    .where(eq(exchangeRates.restaurantId, restaurantId))
    .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
    .limit(1);
  return row ?? null;
}

export const getCurrentRate = (ctx: Pick<TenantContext, "restaurantId">) =>
  withTenant(ctx, (tx) => latestRate(tx, ctx.restaurantId));

/** The history's newest row, and the audit entry that goes with it. */
export async function setExchangeRate(ctx: TenantContext, rate: NewExchangeRate) {
  await withTenant(ctx, async (tx) => {
    const [added] = await tx
      .insert(exchangeRates)
      .values({
        restaurantId: ctx.restaurantId,
        usdToZig: rate.usdToZig,
        setBy: ctx.staffId,
      })
      .returning({ id: exchangeRates.id });
    await recordAudit(tx, ctx, {
      action: "exchange_rate.set",
      entityType: "exchange_rate",
      entityId: added.id,
      details: { usdToZig: rate.usdToZig },
    });
  });
  revalidateMenu(ctx);
}
