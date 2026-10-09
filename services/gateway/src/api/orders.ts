import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi';
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import type { Chain } from '../chain/types.js';
import type { ProposalRow } from '../db/schema.js';
import type { Store } from '../db/store.js';
import { mayUse, wrongAccount } from './account-tokens.js';
import {
  accountParam,
  accountView,
  apiError,
  ordersList,
  proposalBody,
  proposalCreated,
  proposalView,
  registerAccountBody,
  requestIdParam,
} from './schemas.js';

/** The order index, as the routes need it (src/chain/indexer.ts and the chain's finalized tag). */
export type Indexing = { latestFinalized(): Promise<number>; catchUp(): Promise<void> };

export type OrderDeps = {
  store: Store;
  chain: Pick<Chain, 'orderState'>;
  indexing: Indexing | undefined;
  publicUrl: string;
  /**
   * Slice 15: this gateway checks proposals' websites. A proposal is then stored as checking, so
   * its approval waits from the first instant, not from when the check starts a moment later.
   */
  checksWebsites?: boolean;
};

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
const errors = {
  400: json(apiError, 'Malformed: the issues name each field'),
  401: json(apiError, 'Missing or wrong token'),
  403: json(apiError, 'An account token for another account (wrong_account)'),
};
const secured = [{ Bearer: [] }];

const registerAccount = createRoute({
  method: 'post',
  path: '/v1/accounts',
  tags: ['Orders'],
  summary: 'Register an account so its orders are indexed',
  description:
    'Orders are read from the account’s OrderApproved and OrderClosed events on finalized blocks. Pass the account’s creation block to see every order; registering again changes nothing.',
  security: secured,
  request: { body: { content: { 'application/json': { schema: registerAccountBody } } } },
  responses: {
    201: json(accountView, 'Registered; earlier orders appear as the index catches up'),
    200: json(accountView, 'Already registered'),
    503: json(apiError, 'indexing_unavailable'),
    ...errors,
  },
});

const listOrders = createRoute({
  method: 'get',
  path: '/v1/accounts/{account}/orders',
  tags: ['Orders'],
  summary: 'Open orders: supplier, address on file, what is left, expiry',
  description:
    'What is left and the address on file are read from the chain on each call, so they are never stale. An agent matches an invoice to an order with this.',
  security: secured,
  request: { params: accountParam },
  responses: {
    200: json(ordersList, 'Open orders, oldest first'),
    404: json(apiError, 'unknown_account: register it first'),
    503: json(apiError, 'chain_unavailable'),
    ...errors,
  },
});

const propose = createRoute({
  method: 'post',
  path: '/v1/proposals',
  tags: ['Orders'],
  summary: 'Propose a supplier and an order from a quote the agent read',
  description:
    'Nothing changes on chain until the owner signs with their passkey (money rule 8). The same (account, document) is one proposal.',
  security: secured,
  request: { body: { content: { 'application/json': { schema: proposalBody } } } },
  responses: {
    201: json(proposalCreated, 'A new proposal and its approval link'),
    200: json(proposalCreated, 'The same document was proposed before: the first proposal'),
    ...errors,
  },
});

const getProposal = createRoute({
  method: 'get',
  path: '/v1/proposals/{id}',
  tags: ['Orders'],
  summary: 'A proposal and its status',
  security: secured,
  request: { params: requestIdParam },
  responses: {
    200: json(proposalView, 'The proposal'),
    404: json(apiError, 'unknown_proposal'),
    ...errors,
  },
});

/** A proposal's id: one per (account, document). */
export function proposalId(account: Address, documentHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [account, documentHash]),
  );
}

export function proposalViewOf(p: ProposalRow, publicUrl: string): z.infer<typeof proposalView> {
  return {
    id: p.id,
    account: p.account,
    status: p.status,
    supplierName: p.supplierName,
    website: p.website,
    payTo: p.payTo,
    amount: p.amount,
    expiry: p.expiry,
    documentHash: p.documentHash,
    approvalUrl: `${publicUrl}/p/${p.id}`,
    createdAt: p.createdAt.toISOString(),
  };
}

export function registerOrderRoutes(app: OpenAPIHono, deps: OrderDeps): void {
  const { store, chain, publicUrl } = deps;

  app.openapi(registerAccount, async (c) => {
    const body = c.req.valid('json');
    if (!mayUse(c, body.account)) return c.json(wrongAccount, 403);
    if (!deps.indexing) return c.json({ error: 'indexing_unavailable' }, 503);
    const known = (await store.listAccounts()).find((a) => a.address === body.account);
    const fromBlock = body.fromBlock ?? (await deps.indexing.latestFinalized());
    const row = await store.registerAccount(body.account, fromBlock, body.label);
    // Catching up runs in the background: an account created long ago takes a while.
    deps.indexing.catchUp().catch((e: unknown) => {
      console.error(`indexer catch-up: ${e instanceof Error ? e.message : String(e)}`);
    });
    const view = { account: row.address, label: row.label, indexedTo: row.indexedTo };
    return known ? c.json(view, 200) : c.json(view, 201);
  });

  app.openapi(listOrders, async (c) => {
    const { account } = c.req.valid('param');
    if (!mayUse(c, account)) return c.json(wrongAccount, 403);
    const registered = (await store.listAccounts()).find((a) => a.address === account);
    if (!registered) return c.json({ error: 'unknown_account' }, 404);
    const open = await store.openOrders(account, Math.floor(Date.now() / 1000));
    let states;
    try {
      states = await Promise.all(
        open.map((o) => chain.orderState(account, o.vault as Address, o.supplierId as Hex)),
      );
    } catch {
      return c.json({ error: 'chain_unavailable' }, 503);
    }
    const orders = open.map((o, i) => {
      const state = states[i];
      if (!state) throw new Error('order state missing');
      return {
        orderId: o.orderId,
        vault: o.vault,
        supplierId: o.supplierId,
        payTo: state.payTo,
        supplierActive: state.supplierActive,
        activeAfter: state.activeAfter,
        amount: o.amount,
        remaining: state.remaining.toString(),
        expiry: o.expiry,
        approvedBlock: o.approvedBlock,
      };
    });
    return c.json({ account, indexedTo: registered.indexedTo, orders }, 200);
  });

  app.openapi(propose, async (c) => {
    const body = c.req.valid('json');
    if (!mayUse(c, body.account)) return c.json(wrongAccount, 403);
    const { proposal, created } = await store.createProposal({
      id: proposalId(body.account, body.documentHash as Hex),
      account: body.account,
      supplierName: body.supplier.name,
      website: body.supplier.website ?? null,
      payTo: body.supplier.payTo,
      amount: body.order.amount,
      expiry: body.order.expiry,
      documentHash: body.documentHash,
      document: body.document ?? null,
      ...(deps.checksWebsites === true ? { proofStatus: 'checking' as const } : {}),
    });
    const result = { created, proposal: proposalViewOf(proposal, publicUrl) };
    return created ? c.json(result, 201) : c.json(result, 200);
  });

  app.openapi(getProposal, async (c) => {
    const p = await store.getProposal(c.req.valid('param').id);
    return p && mayUse(c, p.account)
      ? c.json(proposalViewOf(p, publicUrl), 200)
      : c.json({ error: 'unknown_proposal' }, 404);
  });
}
