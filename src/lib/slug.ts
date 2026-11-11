/**
 * A restaurant's public address (/r/{slug}) made from its name: the New
 * restaurant sheet fills it in as the admin types, and the restaurants import
 * uses it when a row leaves the slug blank (S-43). Blank when the name has no
 * letters or digits to use.
 */
export function slugFrom(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}
