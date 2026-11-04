/**
 * Writes HTML as a template string, escaping everything put into it: the public
 * menu page has no React to do that (S-32). `html` output nests without being
 * escaped twice, and nothing else can pass as it, so what an owner typed can't
 * become markup.
 */
class Html {
  constructor(private readonly markup: string) {}

  toString() {
    return this.markup;
  }
}

type Value = string | number | Html | Html[] | false | null | undefined;

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (character) => entities[character]);

function render(value: Value): string {
  if (value === false || value === null || value === undefined) return "";
  if (value instanceof Html) return value.toString();
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Value[]) {
  return new Html(
    strings.reduce(
      (markup, text, index) => markup + render(values[index - 1]) + text,
    ),
  );
}

/** For markup written here, never for a value: a stylesheet is the only one. */
export const trusted = (markup: string) => new Html(markup);
