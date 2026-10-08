import { encodeFunctionData, type Address, type Hex } from 'viem';
import { GAS_LIMITS, supplierProofsAbi } from '@countersign/chain';
import { sendAndWait, type OwnerSendDeps } from '../owner/send.js';
import type { SolidityAttestation } from './attestation.js';
import type { ProofRecorder, Prover } from './website.js';

/** Primus signs a proof in about 5 s (Spike 2: 4.2 to 4.9 s); past this, the check has failed. */
const PROVE_TIMEOUT_MS = 30_000;

type PrimusClient = {
  generateRequestParams(
    request: { url: string; method: string; header: Record<string, string>; body: string },
    responseResolves: { keyName: string; parsePath: string }[],
    userAddress?: string,
  ): { setAttMode(mode: { algorithmType: string }): void };
  startAttestation(input: unknown, timeout?: number): Promise<unknown>;
};

/**
 * Primus's Core SDK on this server (S15-7): proxy-TLS, its WebAssembly build (the native one is
 * not built: allowBuilds in pnpm-workspace.yaml). Loaded on first use, so a gateway without
 * Primus keys never loads it; started once and kept.
 */
export class PrimusProver implements Prover {
  private client: Promise<PrimusClient> | undefined;

  constructor(
    private readonly options: {
      appId: string;
      appSecret: string;
      /** Who the proof is for: the registry that records it. */
      recipient: Address;
    },
  ) {}

  private start(): Promise<PrimusClient> {
    this.client ??= (async () => {
      const { PrimusCoreTLS } = await import('@primuslabs/zktls-core-sdk');
      const zkTLS = new PrimusCoreTLS();
      await zkTLS.init(this.options.appId, this.options.appSecret, 'wasm');
      return zkTLS as unknown as PrimusClient;
    })().catch((e: unknown) => {
      this.client = undefined; // try starting again next time
      throw e;
    });
    return this.client;
  }

  async prove(url: string): Promise<unknown> {
    const zkTLS = await this.start();
    // A plain GET with no headers or body, and the one value revealed: what the contract pins.
    const request = zkTLS.generateRequestParams(
      { url, method: 'GET', header: {}, body: '' },
      [{ keyName: 'payTo', parsePath: '$.payTo' }],
      this.options.recipient,
    );
    request.setAttMode({ algorithmType: 'proxytls' });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        zkTLS.startAttestation(request, PROVE_TIMEOUT_MS),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Primus did not answer within ${String(PROVE_TIMEOUT_MS)} ms`));
          }, PROVE_TIMEOUT_MS + 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Records proofs in the SupplierProofs registry through the relayer pool, like any owner action:
 * a dry run first (a proof the contract refuses costs nothing), then sent and waited on until
 * Finalized. Recording the same proof twice is one record, so a retry is safe.
 */
export function registryRecorder(
  deps: OwnerSendDeps & { chain: { dryRun(to: Address, data: Hex): Promise<string | undefined> } },
  registry: Address,
): ProofRecorder {
  return {
    async record(attestation: SolidityAttestation) {
      const data = encodeFunctionData({
        abi: supplierProofsAbi,
        functionName: 'record',
        args: [attestation],
      });
      const refusal = await deps.chain.dryRun(registry, data);
      if (refusal !== undefined) throw new Error(`the registry refuses the proof: ${refusal}`);
      return sendAndWait(
        deps,
        registry,
        data,
        GAS_LIMITS.recordSupplierProof,
        `website proof ${attestation.request.url} ${attestation.timestamp.toString()}`,
      );
    },
  };
}
