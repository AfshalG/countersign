import { describe, expect, it } from 'vitest';
import { decodeFunctionData, hashTypedData, type Address, type Hex } from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
import { accountDomain, ownerActionTypes } from '@countersign/shared';
import { demoPlan, KALIBRE, SETUP_ACTIONS, setupAction, setupCall } from '../../src/demo/plan.js';
import type { WebAuthnAuth } from '../../src/chain/types.js';

const CHAIN_ID = 10143;
const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
const AGENT: Address = '0x2222222222222222222222222222222222222222';
const CHECKER: Address = '0x3333333333333333333333333333333333333333';
const NOW = 1_791_000_000;
const plan = demoPlan({ agentKey: AGENT, checkerKey: CHECKER, now: NOW });
const auth: WebAuthnAuth = {
  r: `0x${'aa'.repeat(32)}`,
  s: `0x${'bb'.repeat(32)}`,
  challengeIndex: 23n,
  typeIndex: 1n,
  authenticatorData: `0x${'cc'.repeat(37)}`,
  clientDataJSON: '{"type":"webauthn.get"}',
};

describe('the demo account plan (judge mode)', () => {
  it('pays Kalibre Studio at its proven address, with small caps and no waiting period', () => {
    expect(plan.policy).toMatchObject({
      agentKey: AGENT,
      checkerKey: CHECKER,
      perPaymentCap: 5_000n,
      newAddressCap: 2_000n,
      waitingPeriod: 0n,
      expiry: BigInt(NOW + 30 * 86_400),
    });
    expect(plan.supplier).toMatchObject({ payTo: KALIBRE.payTo, active: true });
    expect(plan.order).toMatchObject({ supplierId: KALIBRE.supplierId, amount: 5_000n });
    expect(plan.deadline).toBe(BigInt(NOW + 86_400));
  });

  it('asks the passkey to sign the three setup actions at nonces 0, 1 and 2', () => {
    expect(SETUP_ACTIONS).toEqual(['setPolicy', 'setSupplier', 'approveOrder']);
    const policy = setupAction(CHAIN_ID, ACCOUNT, plan, 0);
    expect(policy.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'SetPolicy',
        message: { ...plan.policy, nonce: 0n, deadline: plan.deadline },
      }),
    );
    const supplier = setupAction(CHAIN_ID, ACCOUNT, plan, 1);
    expect(supplier.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'SetSupplier',
        message: { ...plan.supplier, nonce: 1n, deadline: plan.deadline },
      }),
    );
    const order = setupAction(CHAIN_ID, ACCOUNT, plan, 2);
    expect(order.challenge).toBe(
      hashTypedData({
        domain: accountDomain(CHAIN_ID, ACCOUNT),
        types: ownerActionTypes,
        primaryType: 'ApproveOrder',
        message: { ...plan.order, nonce: 2n, deadline: plan.deadline },
      }),
    );
    // Shown to the person (bigints as strings), so the app can say what each signature does.
    expect(order.typedData.message).toMatchObject({ amount: '5000', nonce: '2' });
    expect(order.summary).toContain('0.005 USDC');
  });

  it('encodes each action exactly as the account contract takes it', () => {
    const decoded = (data: Hex) => decodeFunctionData({ abi: countersignAccountAbi, data });
    const p = decoded(setupCall(plan, 0, auth));
    expect(p.functionName).toBe('setPolicy');
    expect(p.args[1]).toBe(0n);
    expect(p.args[2]).toBe(plan.deadline);
    const s = decoded(setupCall(plan, 1, auth));
    expect(s.functionName).toBe('setSupplier');
    expect(s.args.slice(0, 5)).toEqual([
      KALIBRE.supplierId,
      KALIBRE.payTo,
      true,
      plan.supplier.proofHash,
      1n,
    ]);
    const o = decoded(setupCall(plan, 2, auth));
    expect(o.functionName).toBe('approveOrder');
    expect(o.args[3]).toBe(5_000n);
    expect(o.args[5]).toBe(2n);
  });

  it('round-trips through JSON for storage', () => {
    const stored = JSON.parse(JSON.stringify(demoPlan.toJson(plan))) as ReturnType<
      typeof demoPlan.toJson
    >;
    expect(demoPlan.fromJson(stored)).toEqual(plan);
  });
});
