import { parseAbi } from 'viem';

/** Primus's IPrimusZKTLS, as deployed (zktls-contracts at 3082c53). */
export const primusAbi = parseAbi([
  'struct AttNetworkRequest { string url; string header; string method; string body; }',
  'struct AttNetworkResponseResolve { string keyName; string parseType; string parsePath; }',
  'struct Attestor { address attestorAddr; string url; }',
  'struct Attestation { address recipient; AttNetworkRequest request; AttNetworkResponseResolve[] reponseResolve; string data; string attConditions; uint64 timestamp; string additionParams; Attestor[] attestors; bytes[] signatures; }',
  'function verifyAttestation(Attestation attestation) view',
]);
