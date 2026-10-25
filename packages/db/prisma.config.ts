import path from "node:path";
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Load the repo-root .env so every package shares one DATABASE_URL.
config({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Not using prisma's env() helper on purpose: it throws when DATABASE_URL is
  // missing, which breaks `prisma generate` (run on install) before .env exists.
  // Commands that need a database (migrate, studio) still fail clearly without it.
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
