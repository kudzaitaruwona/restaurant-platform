import { defineConfig } from "drizzle-kit";

// `npm run db:generate` only reads the schema and db/migrations, so it needs
// no database. Migrations are applied by `npm run db:migrate`
// (scripts/migrate.mts), which connects through the app's Neon driver.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
});
