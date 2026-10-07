import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { Countersign } from '@countersign/sdk';
import { accessVerifier, type AuthKit } from './auth';
import { createTools } from './tools';

export type ServerOptions = {
  gatewayUrl: string;
  gatewayToken: string;
  chainId: number;
  account: `0x${string}`;
  agentKey: `0x${string}`;
  mcpToken: string;
  /** Sign-in through WorkOS (Slice 13); without it only `mcpToken` is accepted. */
  authkit?: AuthKit;
  /** One line per call: how the caller signed in and who they are. */
  log?: (line: Record<string, unknown>) => void;
  /** For tests: the gateway as a fetch function. */
  fetch?: typeof fetch;
  waitMs?: number;
};

/**
 * The MCP endpoint: the six tools for one account, behind the bearer token or a WorkOS sign-in.
 * Every signed-in person uses the demo account in hosted mode until judge mode (Slice 9 part 4).
 */
export function createServer(options: ServerOptions): (req: Request) => Promise<Response> {
  const cs = new Countersign({
    gateway: options.gatewayUrl,
    token: options.gatewayToken,
    account: options.account,
    agentKey: options.agentKey,
    chainId: options.chainId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const tools = createTools(cs, options.waitMs === undefined ? {} : { waitMs: options.waitMs });
  const mcp = createMcpHandler(
    (server) => {
      server.registerTool(
        'list_open_orders',
        tools.list_open_orders.config,
        tools.list_open_orders.handler,
      );
      server.registerTool('check_invoice', tools.check_invoice.config, tools.check_invoice.handler);
      server.registerTool('pay_invoice', tools.pay_invoice.config, tools.pay_invoice.handler);
      server.registerTool('pay_invoices', tools.pay_invoices.config, tools.pay_invoices.handler);
      server.registerTool(
        'payment_status',
        tools.payment_status.config,
        tools.payment_status.handler,
      );
      server.registerTool('propose_order', tools.propose_order.config, tools.propose_order.handler);
    },
    { serverInfo: { name: 'countersign', version: '0.1.0' } },
  );
  return withMcpAuth(
    (req) => {
      options.log?.({
        via: req.auth?.extra?.via,
        user: req.auth?.extra?.userId,
        client: req.auth?.clientId,
      });
      return mcp(req);
    },
    accessVerifier(options.mcpToken, options.authkit),
    {
      required: true,
      // The 401 names <origin>/.well-known/oauth-protected-resource, from configuration when
      // sign-in is on (behind Vercel's proxy the request's own origin is also right).
      ...(options.authkit ? { resourceUrl: new URL(options.authkit.audience).origin } : {}),
    },
  );
}
