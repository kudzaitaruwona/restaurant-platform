import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 px-4 py-24">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        restaurant-platform
      </h1>
      <p className="text-muted-foreground">
        Menus, autonomous bookings and QR ordering for sit-down restaurants.
      </p>
      <div>
        <Button
          nativeButton={false}
          render={
            <a href="https://github.com/kudzaitaruwona/restaurant-platform" />
          }
        >
          View the project
        </Button>
      </div>
    </main>
  );
}
