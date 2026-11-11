"use client";

/**
 * Names that fill a field when tapped: a shortcut, not a save. Without
 * JavaScript they do nothing and the field is typed into as usual.
 */
export function QuickPicks({ fieldId, names }: { fieldId: string; names: string[] }) {
  function fill(name: string) {
    const field = document.getElementById(fieldId);
    if (!(field instanceof HTMLInputElement)) return;
    field.value = name;
    field.focus();
  }

  return (
    <div role="group" aria-label="Quick picks" className="flex flex-wrap gap-2">
      {names.map((name) => (
        <button
          key={name}
          type="button"
          onClick={() => fill(name)}
          className="inline-flex h-10 items-center rounded-full border border-line bg-surface px-4 text-body font-medium text-ink outline-none transition-[background-color,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.97] motion-reduce:active:scale-100 [@media(hover:hover)_and_(pointer:fine)]:hover:bg-surface-2"
        >
          {name}
        </button>
      ))}
    </div>
  );
}
