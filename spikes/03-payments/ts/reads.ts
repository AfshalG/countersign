import { Pacer } from './pace.js';
import { rpc, RpcError } from './rpc.js';

/** Read endpoints and the share of each one's limit used for reads (Monad caps eth_call at 15/s). */
export const READS = [
  { url: 'https://testnet-rpc.monad.xyz', perSecond: 12 },
  { url: 'https://rpc-testnet.monadinfra.com', perSecond: 10 },
] as const;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Many reads, paced across endpoints, each retried on rate limits and network errors. */
export async function pacedReads<R>(
  count: number,
  method: string,
  params: (i: number) => unknown[],
): Promise<R[]> {
  const pacer = new Pacer(READS.map((r) => r.perSecond));
  const start = Date.now();
  return Promise.all(
    Array.from({ length: count }, async (_, i) => {
      for (let attempt = 1; ; attempt++) {
        const slot = pacer.take(Date.now() - start);
        await sleep(Math.max(0, slot.at - (Date.now() - start)));
        try {
          return await rpc<R>((READS[slot.index] ?? READS[0]).url, method, params(i));
        } catch (e) {
          if (!(e instanceof RpcError) || e.kind === 'rpc' || attempt >= 5) throw e;
          await sleep(200 * attempt);
        }
      }
    }),
  );
}
