import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import nextConfig from "./next.config";

const root = fileURLToPath(new URL(".", import.meta.url));

// Loads .env, .env.local, .env.test and .env.test.local into process.env so
// tests and the integration global setup see them. Next.js's own loader skips
// .env.local when NODE_ENV=test, hence Vite's. Variables already set in the
// shell (as in CI) win over the files.
for (const [key, value] of Object.entries(loadEnv("test", root, ""))) {
  process.env[key] ??= value;
}

// Tests stub DATABASE_URL at the test database themselves. The admin login is
// used by far fewer of them, so point it there once: nothing here should ever
// reach the development database.
if (process.env.TEST_DATABASE_URL_ADMIN) {
  process.env.DATABASE_URL_ADMIN = process.env.TEST_DATABASE_URL_ADMIN;
}

// forbidden() and unauthorized() check this flag. Next.js sets it at build time
// from experimental.authInterrupts; there is no build here, so read the same
// setting. Without it they throw, and the access harness fails, as the app would.
if (nextConfig.experimental?.authInterrupts) {
  process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "true";
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition. Tests run in
      // plain Node, which is a server, so stub it out.
      "server-only": fileURLToPath(
        new URL("./test/stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.int.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["src/**/*.int.test.{ts,tsx}"],
          globalSetup: ["./test/integration/global-setup.ts"],
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Not part of `npm test`: it needs `npm run build` first.
        extends: true,
        test: {
          name: "production",
          environment: "node",
          include: ["test/production/**/*.test.ts"],
          globalSetup: ["./test/integration/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 90_000,
        },
      },
    ],
  },
});
