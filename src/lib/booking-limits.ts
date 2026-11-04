import "server-only";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

/**
 * What stands in front of the guest's confirm before it reads anything (spec 04,
 * abuse controls, proposed): how big a request may be, who is asking, and how
 * often they may ask. The route has no session, so a network address is all there
 * is to count.
 */

// --- size -------------------------------------------------------------------

/**
 * The most a booking request may weigh. Its fields add up to under a kilobyte
 * (a name of 100 characters, a note of 200, a number, a bot-check token of up to
 * 2048 characters per Cloudflare), so 8 KiB is generous *(proposed)*.
 */
export const MAX_BODY_BYTES = 8 * 1024;

/** What the request says it weighs, if it says anything sensible. */
export function declaredLength(headers: Headers): number | undefined | "invalid" {
  const value = headers.get("content-length");
  if (value === null) return undefined;
  return /^[0-9]{1,15}$/.test(value) ? Number(value) : "invalid";
}

/**
 * The body as a form, or "too_large" the moment it passes the limit, however it
 * arrives: Content-Length is checked first by the route and costs nothing, but a
 * chunked body has none, and one that lies is no reason to read on. Anything that
 * isn't a form is an empty one, as before.
 */
export async function readFormWithin(
  request: Request,
  limit = MAX_BODY_BYTES,
): Promise<FormData | "too_large"> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return "too_large";
    }
    chunks.push(value);
  }
  const type = request.headers.get("content-type");
  return new Response(Buffer.concat(chunks), type ? { headers: { "content-type": type } } : {})
    .formData()
    .catch(() => new FormData());
}

// --- who is asking ----------------------------------------------------------

export type IpTrust = { onVercel: boolean; production: boolean };

/**
 * The guest's address, from the one header this deployment can trust *(proposed)*.
 *
 * On Vercel that is `x-vercel-forwarded-for`: Vercel's edge sets it itself on every
 * request, from the connection it accepted, so nothing a client sends can reach it.
 * (`x-forwarded-for` is overwritten there too, but this one is Vercel's own name for
 * it, and it states the promise.) Anywhere else in production there is no proxy we
 * know, so any header would be the client's own word, and there is no address.
 * Outside production, which is development and tests, `x-forwarded-for` is read so
 * the limit can be exercised, because nobody is attacking it.
 */
export function clientIp(headers: Headers, { onVercel, production }: IpTrust) {
  const header = onVercel
    ? headers.get("x-vercel-forwarded-for")
    : production
      ? null
      : headers.get("x-forwarded-for");
  const first = header?.split(",")[0].trim();
  return first && isIP(first) ? first : undefined;
}

const hextets = (ip: string) => {
  const [head, tail] = ip.split("::");
  const side = (part: string | undefined) => {
    const groups = part ? part.split(":") : [];
    const last = groups.at(-1);
    if (last?.includes(".")) {
      const [a, b, c, d] = last.split(".").map(Number);
      groups.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    }
    return groups;
  };
  const left = side(head);
  const right = side(tail);
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(gap).fill("0"), ...right].map((group) =>
    group.toLowerCase().padStart(4, "0"),
  );
};

/**
 * What one visitor is, to the limit. An IPv4 address is itself. An IPv6 address is
 * its /64, because a household or a phone is handed a whole /64 and can use any
 * address in it, so counting addresses would count nobody. An IPv4-mapped IPv6
 * address is the IPv4 it carries.
 */
export function ipBucket(ip: string) {
  if (isIP(ip) === 4) return ip;
  const groups = hextets(ip);
  const mapped = groups.slice(0, 5).every((group) => group === "0000") && groups[5] === "ffff";
  if (mapped) {
    const [high, low] = [groups[6], groups[7]].map((group) => parseInt(group, 16));
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** What is stored for an address: a keyed hash, so the table holds no address (privacy). */
export function limitKey(bucket: string | undefined, secret: string | undefined) {
  const key = bucket === undefined ? "unknown" : `ip:${bucket}`;
  return createHmac("sha256", secret ?? "booking-rate-limit-development")
    .update(`booking-rate-limit:${key}`)
    .digest("base64url");
}

/** Submissions per address per window (spec 04, proposed). Counted in @/lib/tenant/public-limits. */
export const SUBMISSIONS_PER_WINDOW = 5;
