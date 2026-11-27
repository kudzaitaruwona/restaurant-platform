"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type FormEvent,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { postForm } from "@/lib/form-response";
import { savedMessage, type SettingsValues } from "./settings-feedback";
import {
  edited,
  initialFormState,
  left,
  linkTarget,
  received,
  saveAccepted,
} from "./settings-form-state";

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
  zones: readonly string[];
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [state, setState] = useState(() => initialFormState(saved));
  const [posting, setPosting] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<Message>();
  const [badField, setBadField] = useState<string>();
  const [leaving, setLeaving] = useState<string>();

  // `posting` as events see it, before it has rendered: a second press posts nothing.
  const sending = useRef(false);
  // Until the saved values are back. The fields stay editable and keep focus, which a
  // disabled fieldset would take away: what is typed meanwhile stays unsaved (saveAccepted).
  const pending = posting || refreshing;
  const { baseline, dirty, version } = state;

  const next = received(state, saved);
  if (next !== state) setState(next);

  // A refused field takes focus, once the save is no longer out.
  useEffect(() => {
    if (badField === undefined || pending) return;
    const control = form.current?.elements.namedItem(badField);
    if (control instanceof HTMLElement) control.focus();
  }, [badField, pending]);

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
      const to = linkTarget(link.href, window.location.href);
      if (to === undefined) return;
      event.preventDefault();
      setLeaving(to);
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [dirty]);

  function change() {
    if (!form.current) return;
    const now = valuesOf(form.current);
    setState((before) => edited(before, now));
    setMessage(undefined);
    setBadField(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || refreshing) return;
    sending.current = true;
    const body = new FormData(event.currentTarget);
    const posted = valuesOf(event.currentTarget);
    setPosting(true);
    setMessage(undefined);
    setBadField(undefined);
    try {
      const response = await postForm("/api/restaurant", body);
      if (response.ok) {
        const reply = await response.json().catch(() => undefined);
        // What the fields hold by now, if more was typed while the save was out.
        const now = form.current ? valuesOf(form.current) : posted;
        setState((before) => saveAccepted(before, posted, saved, now));
        setMessage({ tone: "positive", text: savedMessage(reply?.bookingSwitchedOff === true) });
        startRefresh(() => router.refresh());
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
      }
    } catch {
      setMessage({ tone: "danger", text: "That didn't reach the server. Try again." });
    } finally {
      sending.current = false;
      setPosting(false);
    }
  }

  // Hundreds of options, which a keystroke elsewhere in the form has no reason to render again.
  const zoneOptions = useMemo(
    () =>
      zones.map((zone) => (
        <option key={zone} value={zone}>
          {zone}
        </option>
      )),
    [zones],
  );

  const errorId = (name: keyof SettingsValues) => `settings-${name}-error`;
  const bad = (name: keyof SettingsValues) => badField === name && message?.tone === "danger";
  const refusal = (name: keyof SettingsValues) => ({
    error: bad(name) ? message?.text : undefined,
    errorId: errorId(name),
  });
  const refused = (name: keyof SettingsValues) =>
    bad(name) ? { "aria-invalid": true, "aria-describedby": errorId(name) } : undefined;

  return (
    <form
      ref={form}
      method="post"
      action="/api/restaurant"
      onSubmit={submit}
      onChange={change}
    >
      <fieldset className="flex flex-col gap-6">
        <Fragment key={version}>
          <Group title="Restaurant" description="Your name and phone, as guests see them.">
            <Field label="Restaurant name" {...refusal("name")}>
              <Input
                name="name"
                defaultValue={baseline.name}
                required
                maxLength={200}
                {...refused("name")}
              />
            </Field>
            <Field
              label="Contact phone"
              hint="A local number like 0771234567 is fine. Guests see it for large parties and booking changes. Online booking needs it."
              {...refusal("contactPhone")}
            >
              <Input
                name="contactPhone"
                type="tel"
                defaultValue={baseline.contactPhone}
                {...refused("contactPhone")}
              />
            </Field>
          </Group>

          <Group title="Guest Wi-Fi" description="Printed on the table QR cards.">
            <Field label="Wi-Fi name" {...refusal("wifiName")}>
              <Input
                name="wifiName"
                defaultValue={baseline.wifiName}
                maxLength={200}
                {...refused("wifiName")}
              />
            </Field>
            <Field
              label="Wi-Fi password"
              hint="Printed on every table QR card, so customers will see it. Use a guest network, not the one your staff or tills use. You can leave it off the sheet when printing."
              {...refusal("wifiPassword")}
            >
              <Input
                name="wifiPassword"
                type="password"
                autoComplete="off"
                defaultValue={baseline.wifiPassword}
                maxLength={200}
                {...refused("wifiPassword")}
              />
            </Field>
          </Group>

          <Group title="Prices and time" description="For the menu, bookings and every screen.">
            <Field label="Currency display" {...refusal("currencyMode")}>
              <Select
                name="currencyMode"
                defaultValue={baseline.currencyMode}
                {...refused("currencyMode")}
              >
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
              hint="Every time on the site is shown in this zone."
              {...refusal("timezone")}
            >
              <Select name="timezone" defaultValue={baseline.timezone} {...refused("timezone")}>
                {zoneOptions}
              </Select>
            </Field>
          </Group>
        </Fragment>

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
          <Button
            type="submit"
            size="staff"
            // Not disabled, which would drop focus; a press while pending posts nothing.
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            className="w-full sm:w-auto"
          >
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
          setState(left);
          setMessage(undefined);
          setBadField(undefined);
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
