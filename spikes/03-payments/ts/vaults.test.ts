import { describe, expect, it } from 'vitest';
import { predictVault } from './vaults.js';

// Reference values from VaultFactory.predictVault on Monad testnet (7 Oct 2026), called
// from the deployer and from 0x…dEaD: the opener is part of the salt.
const deployment = {
  factory: '0xD302044D86E017d84eD6201eF87474D3eb30cf5e',
  implementation: '0xF375CCF017156cfC387a62E1934F9c2a95203139',
  usdc: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
  checker: '0x2e15dBF02F81385d6CdC32208e52213688940736',
} as const;
const supplier = '0x5b7d95bdc25c64501fbb740d0e771cbcd48b0559';
const salt = '0x61f2d630621972c985f3739765f35a6d94d8121d34a7796cac86e022fd491a84';

describe('predictVault', () => {
  it('matches the factory on chain', () => {
    expect(
      predictVault(deployment, '0xf8a69BdB48aeae88136C7F9D87FeB2B24458C79B', supplier, salt),
    ).toBe('0x0CE9EC4a1D310Ff440B05B6a35F971DE1EA2A0ee');
  });

  it('gives a different vault to a different opener', () => {
    expect(
      predictVault(deployment, '0x000000000000000000000000000000000000dEaD', supplier, salt),
    ).toBe('0x35b8f61e92E3d2084B41037c5C7ea0f0EF496746');
  });
});
