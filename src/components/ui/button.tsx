import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

/**
 * Buttons (S-41). Primary is solid black (white in dark); green is never a
 * button colour. Use `buttonVariants()` to style a Link as a button.
 *
 * Sizes: default 44px (guest and general), staff 48px (staff screens), compact
 * 40px (inside a row or band, where the row's padding keeps the hit area 48px).
 */
const baseButtonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-control border border-transparent text-body font-semibold whitespace-nowrap no-underline transition-[background-color,border-color,color,transform] duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        primary:
          "bg-brand text-brand-ink hover:bg-[color-mix(in_srgb,var(--brand)_86%,var(--bg))]",
        secondary:
          "border-line bg-surface text-ink hover:bg-surface-2 aria-expanded:bg-surface-2",
        soft: "bg-brand-soft text-ink hover:bg-[color-mix(in_srgb,var(--brand-soft)_80%,var(--ink))] aria-expanded:bg-[color-mix(in_srgb,var(--brand-soft)_80%,var(--ink))]",
        ghost:
          "bg-transparent text-ink hover:bg-surface-2 aria-expanded:bg-surface-2",
        danger:
          "bg-danger text-on-danger hover:bg-[color-mix(in_srgb,var(--danger)_88%,var(--ink))]",
        "danger-secondary":
          "border-line bg-surface text-danger hover:bg-danger-soft",
        "danger-ghost": "bg-transparent text-danger hover:bg-danger-soft",
        link: "h-auto! border-0 px-0! text-ink underline underline-offset-4 hover:text-ink-2",
        // Names from before S-41, kept so unconverted screens still build.
        default:
          "bg-brand text-brand-ink hover:bg-[color-mix(in_srgb,var(--brand)_86%,var(--bg))]",
        outline:
          "border-line bg-surface text-ink hover:bg-surface-2 aria-expanded:bg-surface-2",
        destructive: "border-line bg-surface text-danger hover:bg-danger-soft",
      },
      size: {
        default: "h-11 px-4",
        staff: "h-12 px-[18px]",
        compact: "h-10 px-3.5",
        /** Before S-41; the same as compact. */
        sm: "h-10 px-3.5",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  }
)

/**
 * The classes for a button, merged so a `className` override wins over the
 * variant's own (e.g. `hidden` over `inline-flex`). Plain cva only joins them.
 */
function buttonVariants(
  options?: Parameters<typeof baseButtonVariants>[0],
) {
  return cn(baseButtonVariants(options))
}

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof baseButtonVariants>

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(baseButtonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants, type ButtonProps }
