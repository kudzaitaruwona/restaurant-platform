import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const appCode = ["**/*.{js,jsx,mjs,ts,tsx,mts}"];
const storageModule = ["src/lib/storage/**"];
// src/db, the tenant seam, sign-in (which runs before any tenant exists), and
// the tooling that runs outside any request: migrations, seeds and the tests'
// own connections.
const databaseSeam = [
  "src/db/**",
  "src/lib/tenant/**",
  "src/lib/auth/**",
  "scripts/**",
  "test/**",
];

// The admin login (S-28): the only files that may open it, because only they are
// the admin path. A subset of the database seam, which can otherwise use getDb.
const adminSeam = [
  "src/db/**",
  "src/lib/tenant/platform-admin.ts",
  "src/lib/tenant/admin-entry.ts",
  "src/lib/auth/database.ts",
  "src/lib/auth/identity.ts",
  "scripts/**",
  "test/**",
];

// Staff sign-in's login (S-28, S-30): the only files that may open it, because
// it can write a working magic link for anyone. The tooling that runs outside
// any request may open it too, as it may the admin login.
const tooling = ["src/db/**", "scripts/**", "test/**"];
const staffAuthSeam = [
  ...tooling,
  "src/lib/auth/database.ts",
  "src/lib/auth/identity.ts",
];

// The system login (spec 01, S-28, S-35): BYPASSRLS across every tenant, so only
// the scheduled job's route opens it, besides the tooling. The Meta webhook's
// route joins this list when it is built.
const systemSeam = ["src/app/api/cron/tick/route.ts"];

// The scheduled job's tasks run outside any tenant, on the system login the
// job's route hands them. They may name the database's type and the tables;
// they open no login of their own.
const cronTasks = ["src/lib/cron/**"];

// Sign-in's own files, the only ones that may use authDatabase(): it hands back
// the admin login or staff sign-in's, so anywhere else it's a way round both.
const authSeam = ["src/lib/auth/**"];
// The two handles sign-in opens both logins through.
const authHandles = staffAuthSeam.filter((file) => file.startsWith("src/lib/auth/"));

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

// Tenant code mustn't reach the role that can call the platform_* functions.
const adminDatabaseBoundary = [
  {
    regex: "(^|/)db/admin$",
    message: "Only the admin seam opens the admin login (S-28).",
  },
];

// Nothing but sign-in reaches the role that can write staff_auth_*.
const staffAuthDatabaseBoundary = [
  {
    regex: "(^|/)db/staff-auth$",
    message: "Only sign-in opens staff sign-in's login (S-28, S-30).",
  },
];

// Nothing but the job's route reaches the role that bypasses RLS.
const systemDatabaseBoundary = [
  {
    regex: "(^|/)db/system$",
    message: "Only the scheduled job's route opens the system login (S-35).",
  },
];

// The job's route: the database boundary bar the system login.
const systemSeamDatabaseBoundary = [
  {
    regex: "(^|/)db(/(?!schema$|system$).*)?$",
    message: "The job's route opens the system login and no other.",
  },
  databaseBoundary[1],
];

const cronTasksDatabaseBoundary = [
  {
    regex: "(^|/)db(/(?!schema$|client$).*)?$",
    message: "The job's tasks use the database the job's route hands them.",
  },
  databaseBoundary[1],
];

const authDatabaseBoundary = [
  {
    regex: "(^|/)auth/database$",
    message: "Only sign-in uses authDatabase (S-28).",
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
    ignores: [...storageModule, ...databaseSeam, ...systemSeam, ...cronTasks],
    rules: restrictImports(storageBoundary, databaseBoundary, authDatabaseBoundary),
  },
  {
    files: cronTasks,
    rules: restrictImports(
      storageBoundary,
      cronTasksDatabaseBoundary,
      adminDatabaseBoundary,
      staffAuthDatabaseBoundary,
      systemDatabaseBoundary,
      authDatabaseBoundary,
    ),
  },
  {
    files: systemSeam,
    rules: restrictImports(
      storageBoundary,
      systemSeamDatabaseBoundary,
      adminDatabaseBoundary,
      staffAuthDatabaseBoundary,
      authDatabaseBoundary,
    ),
  },
  {
    files: storageModule,
    rules: restrictImports(databaseBoundary, authDatabaseBoundary),
  },
  {
    files: databaseSeam,
    ignores: [...adminSeam, ...authSeam],
    rules: restrictImports(
      storageBoundary,
      adminDatabaseBoundary,
      staffAuthDatabaseBoundary,
      systemDatabaseBoundary,
      authDatabaseBoundary,
    ),
  },
  {
    files: adminSeam,
    ignores: [...authSeam, ...tooling],
    rules: restrictImports(
      storageBoundary,
      staffAuthDatabaseBoundary,
      systemDatabaseBoundary,
      authDatabaseBoundary,
    ),
  },
  {
    files: tooling,
    rules: restrictImports(storageBoundary, authDatabaseBoundary),
  },
  {
    files: authSeam,
    ignores: authHandles,
    rules: restrictImports(
      storageBoundary,
      adminDatabaseBoundary,
      staffAuthDatabaseBoundary,
      systemDatabaseBoundary,
    ),
  },
  {
    files: authHandles,
    rules: restrictImports(storageBoundary, systemDatabaseBoundary),
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
