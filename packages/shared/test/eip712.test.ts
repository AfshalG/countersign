import { readFileSync } from 'node:fs';
import { hashTypedData, keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  accountDomain,
  decisionTypes,
  ownerActionTypes,
  paymentTypes,
  vaultDomain,
  type Hex,
} from '../src/eip712.js';

// Digests computed by the contracts themselves in Foundry (contracts/test/Eip712Fixture.t.sol)
// for the same sample values as below. Regenerate with WRITE_EIP712_FIXTURES=1 forge test.
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/eip712.json', import.meta.url), 'utf8'),
) as Record<string, Hex> & {
  chainId: number;
  account: Hex;
  vault: Hex;
};

const k = (s: string) => keccak256(toHex(s));
const NONCE = 7n;
const DEADLINE = 1_790_003_600n;
const A1 = '0x1000000000000000000000000000000000000001';
const A2 = '0x2000000000000000000000000000000000000002';
const A3 = '0x3000000000000000000000000000000000000003';
const A4 = '0x4000000000000000000000000000000000000004';
const supplierId = k('kalibre-studio');
const orderId = k('order-2026-001');

const account = accountDomain(fixture.chainId, fixture.account);
const vault = vaultDomain(fixture.chainId, fixture.vault);

const ownerCases = {
  SetPolicy: {
    agentKey: A1,
    checkerKey: A2,
    perPaymentCap: 100_000n,
    newAddressCap: 20_000n,
    newAddressPeriod: 604_800n,
    waitingPeriod: 172_800n,
    expiry: 1_821_536_000n,
    nonce: NONCE,
    deadline: DEADLINE,
  },
  SetSupplier: {
    supplierId,
    payTo: A3,
    active: true,
    proofHash: k('proof'),
    nonce: NONCE,
    deadline: DEADLINE,
  },
  ApproveOrder: {
    orderId,
    supplierId,
    orderHash: k('purchase order 2026-001, PDF'),
    amount: 50_000n,
    expiry: 1_792_592_000n,
    nonce: NONCE,
    deadline: DEADLINE,
  },
  CloseOrder: { orderId, nonce: NONCE, deadline: DEADLINE },
  Withdraw: { to: A4, amount: 400_000n, nonce: NONCE, deadline: DEADLINE },
  Pause: { nonce: NONCE, deadline: DEADLINE },
  Unpause: { nonce: NONCE, deadline: DEADLINE },
} as const;

describe('EIP-712 types hash exactly as the contracts do', () => {
  for (const [primaryType, message] of Object.entries(ownerCases)) {
    it(`owner action ${primaryType}`, () => {
      const digest = hashTypedData({
        domain: account,
        types: ownerActionTypes,
        primaryType: primaryType as keyof typeof ownerCases,
        message: message as never,
      });
      expect(digest).toBe(fixture[primaryType]);
    });
  }

  it('Payment, in the vault domain', () => {
    const digest = hashTypedData({
      domain: vault,
      types: paymentTypes,
      primaryType: 'Payment',
      message: {
        amount: 10_000n,
        invoiceHash: k('invoice INV-0042, PDF'),
        payTo: A3,
        deadline: DEADLINE,
      },
    });
    expect(digest).toBe(fixture.Payment);
  });

  it('Decision, in the vault domain', () => {
    const digest = hashTypedData({
      domain: vault,
      types: decisionTypes,
      primaryType: 'Decision',
      message: {
        invoiceHash: k('invoice INV-0042, PDF'),
        outcome: 1,
        reasonHash: k('address differs from the one on file'),
        evidenceHash: k('invoice.pdf'),
      },
    });
    expect(digest).toBe(fixture.Decision);
  });

  it('a payment signed for one vault does not match another vault', () => {
    const message = {
      amount: 10_000n,
      invoiceHash: k('invoice INV-0042, PDF'),
      payTo: A3,
      deadline: DEADLINE,
    } as const;
    const other = hashTypedData({
      domain: vaultDomain(fixture.chainId, A4),
      types: paymentTypes,
      primaryType: 'Payment',
      message,
    });
    expect(other).not.toBe(fixture.Payment);
  });
});
