export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-2 px-4 py-12">
      <h1 className="text-heading font-semibold tracking-[-0.015em] text-ink">Restaurant not found</h1>
      <p className="text-body text-ink-2">
        Check the booking link, or ask the restaurant for a new one.
      </p>
    </main>
  );
}
