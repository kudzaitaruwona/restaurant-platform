/**
 * The design system (S-41) for the hand-written guest pages, /t, /m and /b
 * (S-32): the same tokens as src/app/globals.css, the system font stack (no
 * webfont), light and dark by prefers-color-scheme, and the shared guest
 * primitives. One string for a page's <style>, a few KB of the 100KB budget.
 * A test holds the tokens to globals.css.
 *
 * Classes:
 * - .btn, with .btn-primary (solid black, white in dark), .btn-secondary
 *   (outline), .btn-ghost, .btn-danger; .btn-block fills the width. 44px tall.
 * - .pill, with .pill-placed, .pill-cooking, .pill-done, .pill-served,
 *   .pill-voided, .pill-late, .pill-neutral. Put an inline Lucide <svg> first.
 * - .notice, with .notice-attention, .notice-danger, .notice-positive (neutral
 *   by default). An <svg> first, then the text in a <div>.
 * - .chip: a pill-shaped link or button; [aria-current], [aria-pressed=true]
 *   or a checked input inside a <label class="chip"> make it solid.
 * - .input: 48px controls, filled until focused.
 * - .card: surface, hairline, 14px radius.
 * - .sheet: a bottom sheet over .scrim, with .sheet-body (scrolls) and
 *   .sheet-foot (pinned actions).
 * - .muted (secondary text), .num (tabular numerals), .icon (20px Lucide svg).
 */

export const guestTokens = {
  light: {
    bg: "#fafafa",
    surface: "#ffffff",
    "surface-2": "#f2f2f2",
    line: "#e5e5e5",
    ink: "#111111",
    "ink-2": "#5e5e5e",
    brand: "#111111",
    "brand-ink": "#ffffff",
    "brand-soft": "#ededed",
    accent: "#1f7a50",
    "accent-soft": "#e3f2ea",
    "on-accent": "#ffffff",
    attention: "#b86e00",
    "attention-soft": "#fbefd9",
    "attention-ink": "#7a4900",
    "on-attention": "#ffffff",
    danger: "#b3361f",
    "danger-soft": "#f9e3de",
    "on-danger": "#ffffff",
    scrim: "rgb(17 17 17 / 0.45)",
    shadow: "17 17 17",
  },
  dark: {
    bg: "#0b0b0b",
    surface: "#151515",
    "surface-2": "#1e1e1e",
    line: "#2b2b2b",
    ink: "#f2f2f2",
    "ink-2": "#a1a1a1",
    brand: "#f2f2f2",
    "brand-ink": "#111111",
    "brand-soft": "#262626",
    accent: "#4cc38a",
    "accent-soft": "#12301f",
    "on-accent": "#0b0b0b",
    attention: "#f2b24d",
    "attention-soft": "#3a2a10",
    "attention-ink": "#f2b24d",
    "on-attention": "#0c1511",
    danger: "#f07a62",
    "danger-soft": "#3a1a14",
    "on-danger": "#0b0b0b",
    scrim: "rgb(0 0 0 / 0.6)",
    shadow: "0 0 0",
  },
} as const;

const declarations = (tokens: Record<string, string>) =>
  Object.entries(tokens)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";");

export const guestThemeCss = `:root{${declarations(guestTokens.light)};--float:0 12px 32px -8px rgb(var(--shadow)/.22),0 2px 6px rgb(var(--shadow)/.08);color-scheme:light}
@media (prefers-color-scheme:dark){:root{${declarations(guestTokens.dark)};--float:0 12px 32px -8px rgb(var(--shadow)/.55),0 2px 6px rgb(var(--shadow)/.3);color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
button,input,select,textarea{font:inherit;color:inherit}
a{color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.muted{color:var(--ink-2)}
.num{font-variant-numeric:tabular-nums}
.icon{width:20px;height:20px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 16px;border:1px solid transparent;border-radius:10px;font-size:15px;font-weight:600;line-height:1.2;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background-color .15s ease-out,transform .1s ease-out;touch-action:manipulation}
.btn:active{transform:translateY(1px)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.5;pointer-events:none}
.btn-primary{background:var(--brand);color:var(--brand-ink)}
.btn-secondary{background:var(--surface);border-color:var(--line);color:var(--ink)}
.btn-ghost{background:transparent;color:var(--ink)}
.btn-danger{background:var(--danger);color:var(--on-danger)}
.btn-block{display:flex;width:100%}
@media (hover:hover){.btn-primary:hover{background:color-mix(in srgb,var(--brand) 86%,var(--bg))}.btn-secondary:hover,.btn-ghost:hover{background:var(--surface-2)}}
.pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;font-size:13px;font-weight:600;white-space:nowrap}
.pill svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.pill-placed{box-shadow:inset 0 0 0 1px var(--line);color:var(--ink)}
.pill-cooking{background:var(--ink);color:var(--bg)}
.pill-done{background:var(--accent-soft);color:var(--accent)}
.pill-served{color:var(--ink-2)}.pill-served svg{color:var(--accent)}
.pill-voided{background:var(--danger-soft);color:var(--danger)}
.pill-late{background:var(--attention-soft);color:var(--attention-ink)}
.pill-neutral{background:var(--surface-2);color:var(--ink)}
.notice{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-radius:10px;background:var(--surface-2);color:var(--ink)}
.notice>svg{width:20px;height:20px;flex:none;margin-top:2px;fill:none;stroke:var(--ink-2);stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.notice p{margin:0}
.notice-attention{background:var(--attention-soft)}.notice-attention>svg{stroke:var(--attention)}
.notice-danger{background:var(--danger-soft)}.notice-danger>svg{stroke:var(--danger)}
.notice-positive{background:var(--accent-soft)}.notice-positive>svg{stroke:var(--accent)}
.chip{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:999px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:500;text-decoration:none;white-space:nowrap;cursor:pointer}
.chip[aria-current],.chip[aria-pressed=true],.chip:has(input:checked){background:var(--brand);border-color:transparent;color:var(--brand-ink)}
.chip:has(input:disabled),.chip[aria-disabled=true]{border-style:dashed;background:transparent;color:var(--ink-2);cursor:not-allowed}
.chip input{position:absolute;opacity:0;width:1px;height:1px}
.chip:has(input:focus-visible){outline:2px solid var(--accent);outline-offset:2px}
.input{width:100%;min-height:48px;padding:10px 12px;border:1px solid transparent;border-radius:10px;background:var(--surface-2);color:var(--ink);font-size:16px}
.input::placeholder{color:var(--ink-2)}
.input:focus{outline:none;border-color:var(--accent);background:var(--surface)}
.scrim{position:fixed;inset:0;background:var(--scrim);z-index:40}
.sheet{position:fixed;left:0;right:0;bottom:0;z-index:41;display:flex;flex-direction:column;max-height:88dvh;background:var(--surface);border-radius:14px 14px 0 0;box-shadow:var(--float);transition:transform .2s ease-out}
.sheet-body{flex:1;overflow-y:auto;padding:16px}
.sheet-foot{display:flex;gap:12px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--surface)}
.sheet-foot .btn{flex:1}
@media (min-width:640px){.sheet{left:50%;width:min(560px,100%);transform:translateX(-50%)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
`;
