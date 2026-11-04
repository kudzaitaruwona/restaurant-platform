"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, useState } from "react";
import { postForm } from "@/lib/form-response";
import { downscalePhoto } from "./downscale";

/**
 * An item's photo on the menu editor: the thumbnail, a picker and a remove
 * button. Choosing a photo sends it at once, shrunk in the browser first so it
 * fits Vercel's request limit. The picker offers the camera on a phone. Needs
 * JavaScript, like the rest of the editor's richer controls; the server's own
 * limits hold either way.
 */
export function PhotoForm({
  itemId,
  itemName,
  thumbUrl,
}: {
  itemId: string;
  itemName: string;
  thumbUrl: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const route = `/api/menu/items/${itemId}/photo`;

  async function send(action: string, body?: FormData) {
    setPending(true);
    setError(undefined);
    try {
      const response = await postForm(action, body ?? new FormData());
      if (response.ok) router.refresh();
      else setError(await refusalFrom(response));
    } catch {
      setError("That didn't reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function chosen(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const body = new FormData();
    body.set("photo", await downscalePhoto(file));
    input.value = "";
    await send(route, body);
  }

  return (
    <div className="flex items-start gap-3 py-1">
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- already a 320px WebP on the CDN
        <img
          src={thumbUrl}
          alt={`Photo of ${itemName}`}
          width={64}
          height={64}
          loading="lazy"
          className="size-16 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div
          aria-hidden
          className="size-16 shrink-0 rounded-md border border-dashed"
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <input
          type="file"
          name="photo"
          accept="image/*"
          disabled={pending}
          onChange={chosen}
          aria-label={`${thumbUrl ? "Change" : "Add"} photo for ${itemName}`}
          className="max-w-full text-sm"
        />
        {thumbUrl && (
          <form
            method="post"
            action={`${route}/remove`}
            onSubmit={(event) => {
              event.preventDefault();
              void send(`${route}/remove`);
            }}
          >
            <button
              type="submit"
              disabled={pending}
              className="text-sm text-muted-foreground underline"
            >
              Remove photo
            </button>
          </form>
        )}
        {pending && (
          <p role="status" className="text-sm text-muted-foreground">
            Saving photo…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

async function refusalFrom(response: Response) {
  const body = await response.json().catch(() => undefined);
  return typeof body?.error === "string"
    ? body.error
    : "That didn't work. Reload the page and try again.";
}
