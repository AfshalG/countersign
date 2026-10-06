import { z } from 'zod';
import type { WebAuthnAuth } from './encode.js';

const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'hex bytes');
const word = z.string().regex(/^0x[0-9a-fA-F]{64}$/, '32-byte hex');
// Indexes point into clientDataJSON; the cap keeps a public endpoint from
// paying gas for absurd inputs.
const index = z.number().int().min(0).max(4096);

const schema = z.object({
  challenge: hex.max(2 + 2 * 256),
  auth: z.object({
    r: word,
    s: word,
    challengeIndex: index,
    typeIndex: index,
    authenticatorData: hex.max(2 + 2 * 1024),
    clientDataJSON: z.string().min(1).max(4096),
  }),
  qx: word,
  qy: word,
  mode: z.enum(['full', 'native', 'solidity']),
});

/** PasskeyProbe.Mode, in contract order. */
const MODE = { full: 0, native: 1, solidity: 2 } as const;

export type RecordRequest = {
  challenge: `0x${string}`;
  auth: WebAuthnAuth;
  qx: `0x${string}`;
  qy: `0x${string}`;
  mode: 0 | 1 | 2;
};

/** Validates a request from the test page before any gas is spent on it. Throws on bad input. */
export function parseRecordRequest(body: unknown): RecordRequest {
  const b = schema.parse(body);
  return {
    challenge: b.challenge as `0x${string}`,
    auth: {
      r: b.auth.r as `0x${string}`,
      s: b.auth.s as `0x${string}`,
      challengeIndex: BigInt(b.auth.challengeIndex),
      typeIndex: BigInt(b.auth.typeIndex),
      authenticatorData: b.auth.authenticatorData as `0x${string}`,
      clientDataJSON: b.auth.clientDataJSON,
    },
    qx: b.qx as `0x${string}`,
    qy: b.qy as `0x${string}`,
    mode: MODE[b.mode],
  };
}
