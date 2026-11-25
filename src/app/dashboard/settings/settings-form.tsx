"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { postForm } from "@/lib/form-response";
import { savedMessage, type SettingsValues, settingsDirty } from "./settings-feedback";

type Message = { tone: "positive" | "danger"; text: string };

const valuesOf = (form: HTMLFormElement): SettingsValues => {
  const data = new FormData(form);
  const get = (key: keyof SettingsValues) => String(data.get(key) ?? "");
  return {
    name: get("name"),
    contactPhone: get("contactPhone"),
    wifiName: get("wifiName"),
    wifiPassword: get("wifiPassword"),
    currencyMode: get("currencyMode"),
    timezone: get("timezone"),
  };
};

/**
 * The restaurant settings form (S-26). Posts like ActionForm does, but says what
 * happened beside Save, puts a refusal by the field it is about, and warns
 * before unsaved edits are lost.
 */
export function SettingsForm({
  saved,
  currencies,
  zones,
}: {
  saved: SettingsValues;
  currencies: { value: string; label: string }[];
  zones: string[];
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<Message>();
  const [badField, setBadField] = useState<string>();
  const [leaving, setLeaving] = useState<string>();

  // What a save returns (a normalised phone number) replaces what was typed.
  const key = JSON.stringify(saved);
  useEffect(() => {
    form.current?.reset();
  }, [key]);

  // Closing or reloading the tab.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Following a link inside the app, which doesn't unload the page.
  useEffect(() => {
    if (!dirty) return;
    const intercept = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      setLeaving(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [dirty]);

  function edited() {
    if (!form.current) return;
    setDirty(settingsDirty(saved, valuesOf(form.current)));
    setMessage(undefined);
    setBadField(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = event.currentTarget;
    const body = new FormData(target); // before the fieldset disables its controls
    setPending(true);
    setMessage(undefined);
    setBadField(undefined);
    try {
      const response = await postForm("/api/restaurant", body);
      if (response.ok) {
        const reply = await response.json().catch(() => undefined);
        setDirty(false);
        setMessage({ tone: "positive", text: savedMessage(reply?.bookingSwitchedOff === true) });
        router.refresh();
      } else {
        const reply = await response.json().catch(() => undefined);
        const field = typeof reply?.field === "string" ? reply.field : undefined;
        setMessage({
          tone: "danger",
          text:
            typeof reply?.error === "string"
              ? reply.error
              : "That didn't work. Reload the page and try again.",
        });
        setBadField(field);
        // The fieldset is still disabled; focus once it is enabled again.
        setTimeout(() => {
          const control = field ? target.elements.namedItem(field) : null;
          if (control instanceof HTMLElement) control.focus();
        });
      }
    } catch {
      setMessage({ tone: "danger", text: "That didn't reach the server. Try again." });
    } finally {
      setPending(false);
    }
  }

  const problem = (name: string, hint?: ReactNode) => (
    <>
      {badField === name && message?.tone === "danger" && (
        <span role="alert" className="font-medium text-danger">
          {message.text}
        </span>
      )}
      {hint}
    </>
  );
  const invalid = (name: string) => (badField === name ? true : undefined);

  return (
    <form
      ref={form}
      method="post"
      action="/api/restaurant"
      onSubmit={submit}
      onChange={edited}
      onInput={edited}
    >
      <fieldset disabled={pending} className="flex flex-col gap-6">
        <Group title="Restaurant" description="Your name and phone, as guests see them.">
          <Field label="Restaurant name" hint={problem("name")}>
            <Input
              name="name"
              defaultValue={saved.name}
              required
              maxLength={200}
              aria-invalid={invalid("name")}
            />
          </Field>
          <Field
            label="Contact phone"
            hint={problem(
              "contactPhone",
              "A local number like 0771234567 is fine. Guests see it for large parties and booking changes. Online booking needs it.",
            )}
          >
            <Input
              name="contactPhone"
              type="tel"
              defaultValue={saved.contactPhone}
              aria-invalid={invalid("contactPhone")}
            />
          </Field>
        </Group>

        <Group title="Guest Wi-Fi" description="Printed on the table QR cards.">
          <Field label="Wi-Fi name" hint={problem("wifiName")}>
            <Input
              name="wifiName"
              defaultValue={saved.wifiName}
              maxLength={200}
              aria-invalid={invalid("wifiName")}
            />
          </Field>
          <Field
            label="Wi-Fi password"
            hint={problem(
              "wifiPassword",
              "Printed on every table QR card, so customers will see it. Use a guest network, not the one your staff or tills use. You can leave it off the sheet when printing.",
            )}
          >
            <Input
              name="wifiPassword"
              type="password"
              autoComplete="off"
              defaultValue={saved.wifiPassword}
              maxLength={200}
              aria-invalid={invalid("wifiPassword")}
            />
          </Field>
        </Group>

        <Group title="Prices and time" description="For the menu, bookings and every screen.">
          <Field label="Currency display" hint={problem("currencyMode")}>
            <Select name="currencyMode" defaultValue={saved.currencyMode}>
              {currencies.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Link
            href="/dashboard/menu"
            className="-mx-2 flex min-h-12 items-center gap-3 rounded-control px-2 text-body text-ink no-underline outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">Exchange rate</span>
              <span className="text-caption text-ink-2">Set and changed on the Menu page</span>
            </span>
            <ChevronRight aria-hidden className="size-5 shrink-0 text-ink-2" strokeWidth={1.75} />
          </Link>
          <Field
            label="Timezone"
            hint={problem("timezone", "Every time on the site is shown in this zone.")}
          >
            <Select name="timezone" defaultValue={saved.timezone}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </Group>

        <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-end">
          <div className="min-w-0 sm:flex-1">
            {message && (badField === undefined || message.tone === "positive") && (
              <Notice
                tone={message.tone}
                role={message.tone === "danger" ? "alert" : "status"}
              >
                {message.text}
              </Notice>
            )}
            {message?.tone === "danger" && badField !== undefined && (
              <p className="text-body text-danger">Fix the highlighted field, then save again.</p>
            )}
            {!message && dirty && <p className="text-body text-ink-2">You have unsaved changes.</p>}
          </div>
          <Button type="submit" size="staff" className="w-full sm:w-auto">
            Save settings
          </Button>
        </div>
      </fieldset>
      <ConfirmDialog
        open={leaving !== undefined}
        title="Leave without saving?"
        description="Your changes to the settings will be lost."
        confirmLabel="Leave"
        cancelLabel="Stay"
        tone="primary"
        onCancel={() => setLeaving(undefined)}
        onConfirm={() => {
          const to = leaving;
          setLeaving(undefined);
          setDirty(false);
          if (to) router.push(to);
        }}
      />
    </form>
  );
}

/** A titled group: the title beside the card on wide screens, above it on narrow ones. */
function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-8">
      <div className="flex flex-col gap-1 md:pt-5">
        <h2 className="text-lead font-semibold text-ink">{title}</h2>
        <p className="text-caption text-ink-2">{description}</p>
      </div>
      <Card className="flex flex-col gap-5 p-4 sm:p-5">{children}</Card>
    </section>
  );
}
