import { CONFIRMED_FIELD, isConfirmed } from "@/lib/confirmation";
import { FORM_FETCH_HEADER } from "@/lib/form-response";
import { html, trusted } from "@/lib/html";

/**
 * Answers a save that asks first (lib/confirmation.ts): null when nothing needs
 * asking or the post says `confirmed=1`, which is when `warnings` isn't even
 * called, so a confirmed repost runs none of the warning queries. A fetch from
 * ActionForm gets 409 JSON for its dialog. A plain post, with no script to show
 * a dialog, gets a page saying the same with a button that posts it again,
 * confirmed. The restaurant is the session's either way.
 */
export async function confirmationNeeded(
  request: Request,
  form: FormData,
  back: string,
  warnings: () => string[] | Promise<string[]>,
) {
  if (isConfirmed(form)) return null;
  const asked = await warnings();
  if (asked.length === 0) return null;
  if (request.headers.has(FORM_FETCH_HEADER)) {
    return Response.json({ error: asked.join(" "), confirm: { warnings: asked } }, { status: 409 });
  }
  return new Response(confirmPage(new URL(request.url).pathname, form, back, asked).toString(), {
    status: 409,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },
  });
}

const styles = `body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1c1917;background:#fafaf9}
main{max-width:480px;margin:0 auto;padding:24px 16px 48px;display:flex;flex-direction:column;gap:16px}
h1{margin:0;font-size:24px;line-height:1.25}
ul{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}
.actions{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
button{min-height:48px;padding:0 20px;font:inherit;font-weight:600;border-radius:8px;border:0;background:#1c1917;color:#fff}
a{color:inherit}`;

/** Everything typed comes back as hidden fields, so "Save anyway" posts what was posted. */
const confirmPage = (action: string, form: FormData, back: string, warnings: string[]) =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Save anyway?</title>
<style>${trusted(styles)}</style>
</head>
<body><main>
<h1>Save anyway?</h1>
<ul>${warnings.map((warning) => html`<li>${warning}</li>`)}</ul>
<p>Nothing is saved yet.</p>
<form method="post" action="${action}" class="actions">
${[...form.entries()].flatMap(([name, value]) =>
  typeof value === "string" && name !== CONFIRMED_FIELD
    ? [html`<input type="hidden" name="${name}" value="${value}">`]
    : [],
)}
<input type="hidden" name="${CONFIRMED_FIELD}" value="1">
<button type="submit">Save anyway</button>
<a href="${back}">Go back</a>
</form>
</main></body>
</html>
`;
