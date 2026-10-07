import { createServer } from '../../../lib/server';
import { loadSettings } from '../../../lib/settings';

let handler: ((req: Request) => Promise<Response>) | undefined;

function server() {
  if (!handler) {
    const s = loadSettings();
    handler = createServer({
      gatewayUrl: s.GATEWAY_URL,
      gatewayToken: s.GATEWAY_TOKEN,
      chainId: s.MONAD_CHAIN_ID,
      account: s.ACCOUNT as `0x${string}`,
      agentKey: s.AGENT_PRIVATE_KEY as `0x${string}`,
      mcpToken: s.MCP_TOKEN,
    });
  }
  return handler;
}

async function handle(req: Request): Promise<Response> {
  // One line per request in the logs, so each agent app's calls can be told apart.
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      userAgent: req.headers.get('user-agent') ?? 'unknown',
    }),
  );
  return server()(req);
}

export { handle as GET, handle as POST, handle as DELETE };

// Pay tools wait up to 10 s for Monad to finalize.
export const maxDuration = 30;
