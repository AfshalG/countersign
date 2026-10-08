import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

/** Primus's attestor: the signer its own Monad mainnet verifier trusts (owner of 0xCE7c…afdE). */
export const PRIMUS_ATTESTOR: Address = '0xDB736B13E2f522dBE18B2015d0291E4b193D8eF6';

/** Primus's mainnet verifier on Monad (chain 143). Read-only checks only. */
export const PRIMUS_MAINNET_VERIFIER: Address = '0xCE7cefB3B5A7eB44B59F60327A53c9Ce53B0afdE';

const address = z.string().refine((s) => isAddress(s, { strict: false }), 'address');
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/, '65-byte signature');

// Field names follow Primus's struct, including its spelling of "reponseResolve".
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
  signatures: z.array(signature).length(1),
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

/** Validates an attestation from the Primus SDK and shapes it for the Solidity struct. Throws on bad input. */
export function toSolidityAttestation(input: unknown): SolidityAttestation {
  const a = schema.parse(input);
  return {
    recipient: a.recipient,
    request: a.request,
    reponseResolve: a.reponseResolve,
    data: a.data,
    attConditions: a.attConditions,
    timestamp: BigInt(a.timestamp),
    additionParams: a.additionParams,
    attestors: a.attestors.map((x) => ({ attestorAddr: x.attestorAddr, url: x.url })),
    signatures: a.signatures as Hex[],
  };
}

/** The exact `data` Primus attests for a supplier file `{"payTo":"0x…"}` (checksummed address). */
export function expectedPayToData(payTo: string): string {
  return JSON.stringify({ payTo: getAddress(payTo) });
}
