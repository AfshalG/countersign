import { hosted } from '../../../lib/hosted';

async function handle(req: Request): Promise<Response> {
  // One line per request in the logs, so each agent app's calls can be told apart (who signed
  // in is logged once the token is checked).
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      userAgent: req.headers.get('user-agent') ?? 'unknown',
    }),
  );
  return hosted().handler(req);
}

export { handle as GET, handle as POST, handle as DELETE };

// Pay tools wait up to 10 s for Monad to finalize.
export const maxDuration = 30;
