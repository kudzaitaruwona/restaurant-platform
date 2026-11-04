/**
 * A saved form has two kinds of caller. A plain post needs sending on to a page.
 * ActionForm refreshes the page itself, so a redirect would only make fetch
 * render it once more for nothing, and report on that render, not on the save.
 */
export const FORM_FETCH_HEADER = "x-form-fetch";

/** The Origin check in src/proxy.ts applies to this like any other post. */
export const postForm = (action: string, body: FormData) =>
  fetch(action, {
    method: "POST",
    headers: { [FORM_FETCH_HEADER]: "1" },
    body,
  });

export const formSaved = (request: Request, page: string) =>
  request.headers.has(FORM_FETCH_HEADER)
    ? new Response(null, { status: 204 })
    : new Response(null, { status: 303, headers: { Location: page } });
