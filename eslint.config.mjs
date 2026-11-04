import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const appCode = ["**/*.{js,jsx,mjs,ts,tsx,mts}"];
const storageModule = ["src/lib/storage/**"];
// src/db, the tenant seam, and the tooling that runs outside any request:
// migrations, seeds and the tests' own connections.
const databaseSeam = ["src/db/**", "src/lib/tenant/**", "scripts/**", "test/**"];

// Photo storage boundary (D-07): app code touches storage only through
// uploadImage / deleteImage / getUrl from "@/lib/storage".
const storageBoundary = [
  {
    group: ["@aws-sdk/*"],
    message: 'Use uploadImage / deleteImage / getUrl from "@/lib/storage".',
  },
  {
    group: ["@/lib/storage/*", "**/lib/storage/*"],
    message: 'Import storage from "@/lib/storage" only.',
  },
];

// Tenant seam boundary (S-25): a raw database handle has no tenant scoping, so
// app code reaches Postgres only through withTenant from "@/lib/tenant". Table
// definitions from "@/db/schema" are fine: they're needed to write the queries.
const databaseBoundary = [
  {
    // src/db by any path, except its schema.
    regex: "(^|/)db(/(?!schema$).*)?$",
    message: 'Use withTenant from "@/lib/tenant".',
  },
  {
    group: ["@neondatabase/*", "drizzle-orm/neon-*"],
    message: 'Use withTenant from "@/lib/tenant".',
  },
];

const restrictImports = (...boundaries) => ({
  "no-restricted-imports": ["error", { patterns: boundaries.flat() }],
});

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Each boundary lists what its owners may use and everyone else may not. A
  // later config block replaces a rule's options instead of merging them, so
  // the blocks below say exactly which boundaries apply to which files.
  {
    files: appCode,
    ignores: [...storageModule, ...databaseSeam],
    rules: restrictImports(storageBoundary, databaseBoundary),
  },
  {
    files: storageModule,
    rules: restrictImports(databaseBoundary),
  },
  {
    files: databaseSeam,
    rules: restrictImports(storageBoundary),
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
