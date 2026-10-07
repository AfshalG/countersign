import { createMcpHandler } from 'mcp-handler';
import { Countersign } from '@countersign/sdk';
import { tokenMatches } from './auth';
import { createTools } from './tools';

export type ServerOptions = {
  gatewayUrl: string;
  gatewayToken: string;
  chainId: number;
  account: `0x${string}`;
  agentKey: `0x${string}`;
  mcpToken: string;
  /** For tests: the gateway as a fetch function. */
  fetch?: typeof fetch;
  waitMs?: number;
};

/** The MCP endpoint: the six tools for one account, behind the bearer token. */
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
  return async (req: Request) => {
    if (!tokenMatches(req.headers.get('authorization'), options.mcpToken)) {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer error="invalid_token"',
        },
      });
    }
    return mcp(req);
  };
}
