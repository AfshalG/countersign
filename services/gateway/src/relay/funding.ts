/**
 * MON a relayer needs for its share of a run. Monad charges each transaction its gas limit
 * at the charged price (base fee plus tip). Separately, consensus only includes a wallet's
 * transactions while their bids (maxFee × gas limit) for those still in flight fit within
 * its balance from three blocks earlier. At the end of a run that balance has paid for
 * everything but the in-flight ones, so the wallet needs every transaction at the charged
 * price plus the bid headroom for the in-flight ones.
 */
export function walletNeed(p: {
  count: number;
  gasLimit: bigint;
  chargedPrice: bigint;
  maxFee: bigint;
  inFlight: number;
  float: bigint;
}): bigint {
  if (p.maxFee < p.chargedPrice) throw new Error('maxFee is below the charged price');
  const inFlight = BigInt(Math.min(p.count, p.inFlight));
  return (
    BigInt(p.count) * p.gasLimit * p.chargedPrice +
    inFlight * p.gasLimit * (p.maxFee - p.chargedPrice) +
    p.float
  );
}
