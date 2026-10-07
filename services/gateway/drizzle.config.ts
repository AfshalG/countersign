import { defineConfig } from 'drizzle-kit';

// Generates SQL migrations from src/db/schema.ts into drizzle/ (pnpm db:generate).
// The gateway applies them on start with drizzle-orm's migrator.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
});
