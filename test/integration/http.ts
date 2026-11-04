/**
 * The HTTP status Next.js would send for a handler or seam call. notFound(),
 * forbidden() and unauthorized() throw an error whose digest carries the
 * status, and the framework turns that into the response.
 */
export async function statusOf(call: () => Promise<unknown>) {
  try {
    const result = await call();
    return result instanceof Response ? result.status : 200;
  } catch (error) {
    const digest = (error as { digest?: unknown } | null)?.digest;
    const match = /^NEXT_HTTP_ERROR_FALLBACK;(\d+)$/.exec(String(digest));
    if (match) return Number(match[1]);
    throw error;
  }
}
