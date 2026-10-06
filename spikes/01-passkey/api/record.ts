/**
 * Vercel function for the phone test page.
 * GET: the probe address. POST: validate, then send PasskeyProbe.record on testnet.
 * The phone needs no wallet: this endpoint pays the testnet gas.
 */
import deployedJson from '../deployed.json' with { type: 'json' };
import { recordOnMonad, settingsFromEnv } from '../ts/record.js';
import { parseRecordRequest } from '../ts/request.js';

// deployed.json holds null until the probe is deployed.
const deployed = deployedJson as { chainId: number; probe: `0x${string}` | null };

const json = (body: unknown, status = 200): Response =>
  new Response(
    JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );

export function GET(): Response {
  return json({ chainId: deployed.chainId, probe: deployed.probe });
}

export async function POST(request: Request): Promise<Response> {
  const probe = deployed.probe;
  if (!probe) return json({ error: 'probe not deployed' }, 503);
  let req;
  try {
    req = parseRecordRequest(await request.json());
  } catch {
    return json({ error: 'invalid request' }, 400);
  }
  try {
    const result = await recordOnMonad(settingsFromEnv(process.env), probe, req);
    return json(result);
  } catch (error) {
    // The message names what failed (settings, simulation, revert) and never a key.
    const message = error instanceof Error ? error.message.split('\n')[0] : 'unknown error';
    return json({ error: message }, 502);
  }
}
