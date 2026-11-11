"use client";

import { ChevronRight, LoaderCircle, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Field, Input, Select, inputClassName } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { pressable, Reveal } from "../motion";
import { CopyMessage } from "./copy-message";
import { ownerSignInMessage } from "./sign-in-message";

type Step = "restaurant" | "owner" | "done";

/** The public address follows the name until the admin edits it. */
export function slugFrom(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** The iOS drawer curve: quick to move, long to settle. */
const easeDrawer = "ease-[cubic-bezier(0.32,0.72,0,1)]";
/** The strong ease-out, for the steps' own transition. */
const curve = "cubic-bezier(0.23, 1, 0.32, 1)";

/**
 * "New restaurant" as a right-hand sheet in two steps (spec 01, S-26): the
 * restaurant, then its first owner, each posted to its existing route in turn.
 * A native <dialog>, so focus is held inside and Escape closes it; its fields
 * are in the markup from the start, so nothing changes size between steps.
 */
export function NewRestaurantSheet({
  timezone,
  currencyModes,
  appUrl,
}: {
  timezone: string;
  currencyModes: { value: string; label: string }[];
  appUrl: string;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const restaurantForm = useRef<HTMLFormElement>(null);
  const ownerForm = useRef<HTMLFormElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const ownerNameField = useRef<HTMLInputElement>(null);
  const doneHeading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step>("restaurant");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [restaurant, setRestaurant] = useState<{ id: string; name: string }>();
  const [owner, setOwner] = useState<{ name: string; email: string }>();
  const [pending, setPending] = useState(false);
  // Kept after it's dismissed, so the closing Reveal still has words in it.
  const [error, setError] = useState<string>();
  const [showError, setShowError] = useState(false);

  // Focus moves with the step: its first field, or the heading of the last one.
  useEffect(() => {
    if (!dialog.current?.open) return;
    // Reopened after a finished run: the first step was inert when open() ran.
    if (step === "restaurant") nameField.current?.focus();
    if (step === "owner") ownerNameField.current?.focus();
    if (step === "done") doneHeading.current?.focus();
  }, [step]);

  function open() {
    restaurantForm.current?.reset();
    ownerForm.current?.reset();
    setStep("restaurant");
    setSlug("");
    setSlugEdited(false);
    setRestaurant(undefined);
    setOwner(undefined);
    setShowError(false);
    dialog.current?.showModal();
    nameField.current?.focus();
  }

  const close = () => dialog.current?.close();

  async function post(action: string, form: HTMLFormElement) {
    setPending(true);
    setShowError(false);
    try {
      const response = await fetch(action, { method: "POST", body: new FormData(form) });
      const body = await response.json().catch(() => undefined);
      if (response.ok) return body as { id: string };
      setError(body?.error ?? "That didn't work. Try again.");
    } catch {
      setError("That didn't work. Try again.");
    } finally {
      setPending(false);
    }
    setShowError(true);
    return undefined;
  }

  async function createRestaurant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const created = await post("/api/admin/restaurants", form);
    if (!created) return;
    setRestaurant({ id: created.id, name: String(new FormData(form).get("name") ?? "").trim() });
    setStep("owner");
    router.refresh();
  }

  async function createOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restaurant) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const created = await post(`/api/admin/restaurants/${restaurant.id}/owner`, form);
    if (!created) return;
    setOwner({
      name: String(data.get("displayName") ?? ""),
      email: String(data.get("email") ?? "").trim().toLowerCase(),
    });
    setStep("done");
    router.refresh();
  }

  // A step arrives with a short fade, a 6px rise and a 2px blur, and leaves faster.
  // Visibility flips at once on the way in, so its first field can take focus
  // straight away, and only after the fade on the way out.
  const stepProps = (active: boolean) => ({
    inert: !active,
    "aria-hidden": !active,
    className: cn(
      "col-start-1 row-start-1 flex min-w-0 flex-col gap-5",
      active ? "visible translate-y-0 opacity-100 blur-none" : "invisible translate-y-1.5 opacity-0 blur-[2px]",
      "motion-reduce:translate-y-0 motion-reduce:blur-none",
    ),
    style: {
      transition: active
        ? `opacity 200ms ${curve}, translate 200ms ${curve}, filter 200ms ${curve}`
        : `opacity 150ms ${curve}, translate 150ms ${curve}, filter 150ms ${curve}, visibility 0s linear 150ms`,
    },
  });

  const submitButton = (form: string, label: string) => (
    <Button
      type="submit"
      form={form}
      disabled={pending}
      aria-busy={pending || undefined}
      className={pressable}
    >
      {/* Both stacked in one cell, so the spinner never changes the button's width. */}
      <span className="grid place-items-center">
        <span className={cn("col-start-1 row-start-1", pending && "invisible")}>{label}</span>
        {pending && (
          <LoaderCircle
            aria-hidden
            className="col-start-1 row-start-1 animate-spin [animation-duration:700ms] motion-reduce:animate-none"
          />
        )}
      </span>
    </Button>
  );

  return (
    <>
      <Button type="button" size="compact" onClick={open} className={pressable}>
        <Plus aria-hidden />
        New restaurant
      </Button>

      <dialog
        ref={dialog}
        aria-labelledby="new-restaurant-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        className={cn(
          "fixed inset-y-0 right-0 left-auto m-0 flex h-dvh max-h-none w-full max-w-[440px] flex-col border-0 border-l border-line bg-surface p-0 text-ink shadow-float [&:not([open])]:hidden",
          // Slides in from the right: 300ms in, 200ms out; just a fade under reduced motion.
          "translate-x-full transition-[translate,opacity,overlay,display] transition-discrete duration-200 open:translate-x-0 open:duration-300 starting:open:translate-x-full",
          easeDrawer,
          "motion-reduce:translate-x-0 motion-reduce:opacity-0 motion-reduce:open:opacity-100 motion-reduce:starting:open:opacity-0",
          "backdrop:bg-scrim backdrop:opacity-0 backdrop:transition-[opacity,overlay,display] backdrop:transition-discrete backdrop:duration-200 open:backdrop:opacity-100 starting:open:backdrop:opacity-0",
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-line py-3 pr-3 pl-6">
          <div className="flex flex-col gap-1 pt-1">
            <h2 id="new-restaurant-title" className="text-title font-semibold">
              New restaurant
            </h2>
            <ol aria-label="Steps" className="flex items-center gap-1.5 text-caption text-ink-2">
              <StepLabel current={step === "restaurant"}>1 Restaurant</StepLabel>
              <ChevronRight aria-hidden className="size-4" />
              <StepLabel current={step !== "restaurant"}>2 Owner</StepLabel>
            </ol>
          </div>
          <IconButton label="Close" icon={<X />} variant="ghost" size="default" onClick={close} />
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
          <div className="grid">
            <form
              ref={restaurantForm}
              id="new-restaurant-form"
              onSubmit={createRestaurant}
              {...stepProps(step === "restaurant")}
            >
              <Field label="Name">
                <input
                  ref={nameField}
                  className={inputClassName}
                  name="name"
                  required
                  maxLength={200}
                  autoComplete="off"
                  onChange={(event) => {
                    if (!slugEdited) setSlug(slugFrom(event.currentTarget.value));
                  }}
                />
              </Field>
              <Field
                label="Public address"
                hint="Guests book at this address. Filled from the name; change it if you like."
              >
                <span
                  className={cn(
                    inputClassName,
                    "flex items-center gap-0 py-0 pr-0 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
                  )}
                >
                  <span aria-hidden className="text-ink-2">/r/</span>
                  <input
                    name="slug"
                    required
                    maxLength={63}
                    autoComplete="off"
                    spellCheck={false}
                    value={slug}
                    onChange={(event) => {
                      setSlugEdited(true);
                      setSlug(event.currentTarget.value);
                    }}
                    className="h-full min-h-11 w-full min-w-0 bg-transparent pr-3 text-ink outline-none"
                  />
                </span>
              </Field>
              <Field label="Timezone">
                <Input name="timezone" required defaultValue={timezone} />
              </Field>
              <Field label="Currency">
                <Select name="currencyMode" required>
                  {currencyModes.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
            </form>

            <form
              ref={ownerForm}
              id="new-owner-form"
              onSubmit={createOwner}
              {...stepProps(step === "owner")}
            >
              <Notice tone="positive" role="status">
                <b className="font-semibold">{restaurant?.name || "The restaurant"}</b> is created. Its
                first person is its owner.
              </Notice>
              <Field label="Owner's name">
                <input
                  ref={ownerNameField}
                  name="displayName"
                  required
                  maxLength={200}
                  className={inputClassName}
                />
              </Field>
              <Field
                label="Owner's email"
                hint="They sign in with this email. No invite is sent; you tell them."
              >
                <Input name="email" type="email" required autoComplete="off" />
              </Field>
            </form>

            <section
              {...stepProps(step === "done")}
              aria-labelledby="new-owner-done"
            >
              <Notice tone="positive">
                <h3 id="new-owner-done" ref={doneHeading} tabIndex={-1} className="outline-none">
                  <b className="font-semibold">{owner?.name}</b> is the owner of{" "}
                  <b className="font-semibold">{restaurant?.name}</b>.
                </h3>
              </Notice>
              <p className="text-body text-ink-2">
                Send them this on WhatsApp. It tells them how to sign in.
              </p>
              {restaurant && owner && (
                <CopyMessage
                  text={ownerSignInMessage({
                    restaurantName: restaurant.name,
                    appUrl,
                    ownerName: owner.name,
                    ownerEmail: owner.email,
                  })}
                />
              )}
            </section>
          </div>

          <Reveal open={showError}>
            <div className="pt-5">
              {error && (
                <Notice role={showError ? "alert" : undefined} tone="danger">
                  {error}
                </Notice>
              )}
            </div>
          </Reveal>
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-line px-6 py-4">
          {step === "restaurant" && submitButton("new-restaurant-form", "Create restaurant")}
          {step === "owner" && (
            <>
              <Button type="button" variant="ghost" onClick={close} className={pressable}>
                Add the owner later
              </Button>
              {submitButton("new-owner-form", "Add owner")}
            </>
          )}
          {step === "done" && (
            <Button type="button" onClick={close} className={pressable}>
              Done
            </Button>
          )}
        </footer>
      </dialog>
    </>
  );
}

function StepLabel({ current, children }: { current: boolean; children: ReactNode }) {
  return (
    <li aria-current={current ? "step" : undefined} className={cn(current && "font-semibold text-ink")}>
      {children}
    </li>
  );
}
