import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRequestListener } from '@hono/node-server';
import { createMCPClient } from '@ai-sdk/mcp';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { generatePrivateKey } from 'viem/accounts';
import { createServer } from '../lib/server';
import { authorizationServer, discoveryDocument, protectedResource } from '../lib/discovery';
import { authkitSettings, loadSettings } from '../lib/settings';
import { registrationOf } from '../lib/agents';

const MCP_TOKEN = 'mcp-test-token-0123456789abcdef';
const ISSUER = 'https://countersign-test.authkit.app';
let http: Server;
let url: string;
let sign: (
  claims: { aud?: string; iss?: string; exp?: number },
  key?: 'ours' | 'other',
) => Promise<string>;

beforeAll(async () => {
  const ours = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(ours.publicKey)), kid: 'k1', alg: 'RS256' };
  // The handler needs the server's URL (its token audience), so the listener is set after listen().
  const route: { listener?: ReturnType<typeof getRequestListener> } = {};
  http = createHttpServer((req, res) => {
    void route.listener?.(req, res);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}/api/mcp`;
  const handler = createServer({
    gatewayUrl: 'https://gateway.test',
    gatewayToken: 'gateway-token-0123456789abcdef',
    chainId: 10143,
    account: '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603',
    agentKey: generatePrivateKey(),
    mcpToken: MCP_TOKEN,
    authkit: { issuer: ISSUER, audience: url, keys: createLocalJWKSet({ keys: [jwk] }) },
    fetch: () => Promise.reject(new Error('no gateway in this test')),
  });
  route.listener = getRequestListener(handler);
  sign = (claims, key = 'ours') =>
    new SignJWT({ client_id: 'client_grok', scope: 'openid profile' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(claims.iss ?? ISSUER)
      .setAudience(claims.aud ?? url)
      .setSubject('user_01')
      .setIssuedAt()
      .setExpirationTime(claims.exp ?? Math.floor(Date.now() / 1000) + 300)
      .sign((key === 'ours' ? ours : other).privateKey);
});
afterAll(async () => {
  await new Promise((resolve) => http.close(resolve));
});

const listTools = async (token: string) => {
  const client = await createMCPClient({
    transport: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    return (await client.listTools()).tools.map((t) => t.name);
  } finally {
    await client.close();
  }
};
const rawStatus = async (token?: string) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return { status: res.status, challenge: res.headers.get('www-authenticate') };
};

describe('sign-in for agent apps (WorkOS AuthKit)', () => {
  it('answers a request without a token with where to sign in', async () => {
    const { status, challenge } = await rawStatus();
    expect(status).toBe(401);
    expect(challenge).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
  });

  it('accepts a WorkOS access token for this server', async () => {
    expect(await listTools(await sign({}))).toContain('pay_invoice');
  });

  it('still accepts the bearer token (Claude Code, Codex, scripts, Muse)', async () => {
    expect(await listTools(MCP_TOKEN)).toContain('list_open_orders');
  });

  it('refuses a token for another audience, another issuer, an expired one, or one signed by another key', async () => {
    for (const token of [
      await sign({ aud: 'https://another-server.example/mcp' }),
      await sign({ iss: 'https://evil.authkit.app' }),
      await sign({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await sign({}, 'other'),
    ])
      expect((await rawStatus(token)).status).toBe(401);
  });

  it('publishes the protected resource document naming WorkOS', () => {
    expect(discoveryDocument(ISSUER, 'https://countersign-mcp.vercel.app/api/mcp')).toMatchObject({
      resource: 'https://countersign-mcp.vercel.app/api/mcp',
      authorization_servers: [ISSUER],
    });
  });
});

describe('sign-in settings and the well-known routes', () => {
  const base = {
    GATEWAY_URL: 'https://gateway.test',
    GATEWAY_TOKEN: 'gateway-token-0123456789abcdef',
    MONAD_CHAIN_ID: '10143',
    ACCOUNT: '0xE890B35be32F04032B502Dc4Dc2db8062aD6d603',
    AGENT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    MCP_TOKEN,
  };

  it('turns sign-in on only when both the AuthKit domain and the public URL are set', () => {
    expect(authkitSettings(loadSettings(base))).toBeUndefined();
    expect(
      authkitSettings(
        loadSettings({
          ...base,
          AUTHKIT_DOMAIN: 'countersign-test.authkit.app',
          MCP_PUBLIC_URL: 'https://countersign-mcp.vercel.app/api/mcp',
        }),
      ),
    ).toEqual({ issuer: ISSUER, audience: 'https://countersign-mcp.vercel.app/api/mcp' });
    expect(() =>
      authkitSettings(loadSettings({ ...base, AUTHKIT_DOMAIN: 'countersign-test.authkit.app' })),
    ).toThrow(/both/);
  });

  it('says plainly when sign-in is not configured, and passes WorkOS’s metadata through', async () => {
    expect(protectedResource(undefined).status).toBe(404);
    const ok = await authorizationServer(ISSUER, (input) => {
      expect(input).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
      return Promise.resolve(Response.json({ issuer: ISSUER }));
    });
    expect(await ok.json()).toEqual({ issuer: ISSUER });
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('answers 502 when WorkOS does not', async () => {
    const down = await authorizationServer(ISSUER, () => Promise.reject(new Error('offline')));
    expect(down.status).toBe(502);
    const bad = await authorizationServer(ISSUER, () =>
      Promise.resolve(new Response('', { status: 500 })),
    );
    expect(bad.status).toBe(502);
  });
});

describe('ERC-8004 registration files', () => {
  it('serves each agent’s file in the ERC-8004 format, with its id and our doors', () => {
    expect(registrationOf('countersign-hosted')).toMatchObject({
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      registrations: [
        { agentId: 2066, agentRegistry: 'eip155:10143:0x8004A818BFB912233c491871b3d84c89A494BD9e' },
      ],
      services: [
        { name: 'MCP', endpoint: 'https://countersign-mcp.vercel.app/api/mcp' },
        { name: 'A2A' },
      ],
    });
    expect(registrationOf('countersign-demo')?.registrations[0]?.agentId).toBe(2067);
    expect(registrationOf('nobody')).toBeUndefined();
  });
});
