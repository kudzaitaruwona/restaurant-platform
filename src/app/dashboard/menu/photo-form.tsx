"use client";

import { useRouter } from "next/navigation";
import { ImagePlus } from "lucide-react";
import { type ChangeEvent, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
    <div className="flex items-start gap-4">
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- already a 320px WebP on the CDN
        <img
          src={thumbUrl}
          alt={`Photo of ${itemName}`}
          width={64}
          height={64}
          loading="lazy"
          className="size-16 shrink-0 rounded-control bg-surface-2 object-cover"
        />
      ) : (
        <div
          aria-hidden
          className="flex size-16 shrink-0 items-center justify-center rounded-control border border-dashed border-line text-ink-2 [&_svg]:size-6"
        >
          <ImagePlus strokeWidth={1.75} />
        </div>
      )}
      <div className="flex min-w-0 flex-col items-start gap-2">
        <span className="text-caption font-medium text-ink-2">Photo, optional</span>
        <input
          type="file"
          name="photo"
          accept="image/*"
          disabled={pending}
          onChange={chosen}
          aria-label={`${thumbUrl ? "Change" : "Add"} photo for ${itemName}`}
          className="max-w-full text-caption text-ink-2 file:mr-3 file:h-10 file:cursor-pointer file:rounded-control file:border file:border-line file:bg-surface file:px-3.5 file:text-body file:font-semibold file:text-ink hover:file:bg-surface-2 disabled:opacity-50"
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
              className={cn(buttonVariants({ variant: "danger-ghost", size: "compact", className: "-ml-3.5" }))}
            >
              Remove photo
            </button>
          </form>
        )}
        {pending && (
          <p role="status" className="text-caption text-ink-2">
            Saving photo…
          </p>
        )}
        {error && (
          <p role="alert" className="text-caption text-danger">
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
