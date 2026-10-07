import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';

type Deployment = { factory: Address; implementation: Address; usdc: Address; checker: Address };

/**
 * A vault's address, computed locally the way VaultFactory and OpenZeppelin's Clones do
 * (CREATE2 over the clone code with its immutable arguments). Saves 200 rate-limited
 * calls per set; the tests pin it to the factory's own answer on chain.
 */
export function predictVault(
  d: Deployment,
  opener: Address,
  supplier: Address,
  salt: Hex,
): Address {
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [d.usdc, supplier, d.checker],
  );
  const argsLength = (args.length - 2) / 2;
  // Clones._cloneCodeWithImmutableArgs (OpenZeppelin 5.7.0)
  const cloneCode = concat([
    '0x61',
    numberToHex(argsLength + 0x2d, { size: 2 }),
    '0x3d81600a3d39f3363d3d373d3d3d363d73',
    d.implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
    args,
  ]);
  const factorySalt = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
      [opener, supplier, salt],
    ),
  );
  return getContractAddress({
    opcode: 'CREATE2',
    from: d.factory,
    salt: factorySalt,
    bytecode: cloneCode,
  });
}
