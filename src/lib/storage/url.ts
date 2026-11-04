/**
 * Keys and public URLs: plain string work, kept apart from the S3 client so the
 * public menu page can print a photo's address without loading the SDK.
 */

const SAFE_KEY = /^[A-Za-z0-9._+ -]+(\/[A-Za-z0-9._+ -]+)*$/;

export function assertSafeKey(key: string) {
  const segments = key.split("/");
  if (!SAFE_KEY.test(key) || segments.some((s) => s === "." || s === "..")) {
    throw new Error(
      `Invalid storage key ${JSON.stringify(key)}: use relative, slash-separated segments without "." or "..".`,
    );
  }
}

/** `publicBaseUrl` is the bucket's custom domain, without a trailing slash. */
export function publicUrl(publicBaseUrl: string, key: string) {
  assertSafeKey(key);
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${publicBaseUrl}/${path}`;
}
