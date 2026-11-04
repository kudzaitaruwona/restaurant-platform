import { randomBytes } from "node:crypto";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LENGTH = 22; // 22 * log2(62) = 131 bits (spec 03 › Token rules)

/**
 * A table's permanent QR token: 22 characters of base62 from the system's
 * random source. Bytes at or above 248 are dropped rather than wrapped, because
 * 256 isn't a multiple of 62 and wrapping would favour the first few characters.
 */
export function mintQrToken() {
  let token = "";
  while (token.length < LENGTH) {
    for (const byte of randomBytes(LENGTH * 2)) {
      if (byte < 248 && token.length < LENGTH) token += ALPHABET[byte % 62];
    }
  }
  return token;
}
