/**
 * Local stand-in for Vercel: serves public/ and runs api/record.ts on
 * http://localhost:5173. Browsers allow passkeys on localhost without HTTPS,
 * so the Mac (Touch ID) can be tested before deploying. Run: pnpm dev
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

process.loadEnvFile(new URL('../../../.env', import.meta.url));
const api = await import('../api/record.js');
const page = new URL('../public/index.html', import.meta.url);
const port = 5173;

createServer((req, res) => {
  void (async () => {
    try {
      if (req.url === '/api/record') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const request = new Request(`http://localhost:${String(port)}/api/record`, {
          method: req.method ?? 'GET',
          headers: { 'content-type': 'application/json' },
          ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = req.method === 'POST' ? await api.POST(request) : api.GET();
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(await response.text());
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(await readFile(page));
    } catch (error) {
      res.writeHead(500);
      res.end(error instanceof Error ? error.message : 'error');
    }
  })();
}).listen(port, () => {
  console.log(`http://localhost:${String(port)}`);
});
