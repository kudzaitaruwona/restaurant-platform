export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-2 px-4 py-12">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Restaurant not found</h1>
      <p className="text-muted-foreground">
        Check the booking link, or ask the restaurant for a new one.
      </p>
    </main>
  );
}
