import { fileURLToPath } from 'node:url';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Database = { pool: Pool; db: Db };

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Opens a connection pool and, unless told not to, applies any pending migrations. */
export async function connect(
  url: string,
  options: { migrate?: boolean; max?: number } = {},
): Promise<Database> {
  const pool = new Pool({ connectionString: url, max: options.max ?? 10 });
  // A dropped idle connection must not crash the process; the pool replaces it.
  pool.on('error', (err) => {
    console.error(`postgres pool: ${err.message}`);
  });
  const db = drizzle(pool, { schema });
  if (options.migrate !== false) await migrate(db, { migrationsFolder });
  return { pool, db };
}
