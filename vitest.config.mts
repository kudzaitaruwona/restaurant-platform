import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// Loads .env, .env.local, .env.test and .env.test.local into process.env so
// tests and the integration global setup see them. Next.js's own loader skips
// .env.local when NODE_ENV=test, hence Vite's. Variables already set in the
// shell (as in CI) win over the files.
for (const [key, value] of Object.entries(loadEnv("test", root, ""))) {
  process.env[key] ??= value;
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
    ],
  },
});
