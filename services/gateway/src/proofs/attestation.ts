import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

/**
 * A Primus proof as the SupplierProofs contract takes it (Slice 15; the shape Spike 2 checked).
 * Field names follow Primus's struct, including its spelling of "reponseResolve".
 */
const address = z.string().refine((s) => isAddress(s, { strict: false }), 'address');

const schema = z.object({
  recipient: address,
  request: z.object({ url: z.string(), header: z.string(), method: z.string(), body: z.string() }),
  reponseResolve: z.array(
    z.object({ keyName: z.string(), parseType: z.string(), parsePath: z.string() }),
  ),
  data: z.string(),
  attConditions: z.string(),
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  additionParams: z.string(),
  attestors: z.array(z.object({ attestorAddr: address, url: z.string() })),
  // Primus's verifier requires exactly one 65-byte signature.
  signatures: z.array(z.string().regex(/^0x[0-9a-fA-F]{130}$/)).length(1),
});

export type SolidityAttestation = {
  recipient: Address;
  request: { url: string; header: string; method: string; body: string };
  reponseResolve: { keyName: string; parseType: string; parsePath: string }[];
  data: string;
  attConditions: string;
  /** Milliseconds since the epoch (Primus's unit), as uint64. */
  timestamp: bigint;
  additionParams: string;
  attestors: { attestorAddr: Address; url: string }[];
  signatures: Hex[];
};

/** Validates a proof from the Primus SDK and shapes it for the contract. Throws on bad input. */
export function toSolidityAttestation(input: unknown): SolidityAttestation {
  const a = schema.parse(input);
  return {
    recipient: getAddress(a.recipient),
    request: a.request,
    reponseResolve: a.reponseResolve,
    data: a.data,
    attConditions: a.attConditions,
    timestamp: BigInt(a.timestamp),
    additionParams: a.additionParams,
    attestors: a.attestors.map((x) => ({ attestorAddr: getAddress(x.attestorAddr), url: x.url })),
    signatures: a.signatures as Hex[],
  };
}

/**
 * The address in Primus's `{"payTo":"0x…"}`, exactly as the contract reads it (either letter case),
 * or null. The contract is the judge; this tells the gateway what it will record.
 */
export function listedIn(data: string): Address | null {
  const m = /^\{"payTo":"(0x[0-9a-fA-F]{40})"\}$/.exec(data);
  return m?.[1] ? getAddress(m[1]) : null;
}
