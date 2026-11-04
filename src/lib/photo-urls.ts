import "server-only";
import { getUrl } from "@/lib/storage";

/**
 * Where an item's two photo files live. Kept apart from photo-image.ts so the
 * public page, which only needs addresses, doesn't load the image library.
 */
export const photoSizes = { large: "-800.webp", thumb: "-320.webp" } as const;

export const photoKeys = (photoKey: string) => ({
  large: `${photoKey}${photoSizes.large}`,
  thumb: `${photoKey}${photoSizes.thumb}`,
});

/** Public URLs, from the storage interface (D-07), for an item's photo key. */
export const photoUrls = (photoKey: string) => {
  const keys = photoKeys(photoKey);
  return { large: getUrl(keys.large), thumb: getUrl(keys.thumb) };
};
