import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { loadEnv } from '@countersign/shared';
import { connect, type Database } from '../../src/db/client.js';

/** A clean, migrated database for one test file. Wipes TEST_DATABASE_URL: never point it at real data. */
export async function freshDatabase(): Promise<Database> {
  const { TEST_DATABASE_URL } = loadEnv(z.object({ TEST_DATABASE_URL: z.url() }));
  const reset = await connect(TEST_DATABASE_URL, { migrate: false });
  await reset.db.execute(sql`drop schema if exists public cascade`);
  await reset.db.execute(sql`drop schema if exists drizzle cascade`);
  await reset.db.execute(sql`create schema public`);
  await reset.pool.end();
  return connect(TEST_DATABASE_URL);
}

export async function truncate(database: Database): Promise<void> {
  await database.db.execute(
    sql`truncate payment_events, payment_requests, runs, relayer_nonces, accounts, orders, proposals, demo_accounts, relayer_txs, agents, owner_signatures, whatsapp_contacts, whatsapp_links, whatsapp_messages, api_tokens, website_proofs, supplier_websites, run_requests, supplier_banks, advice_checks restart identity cascade`,
  );
}
