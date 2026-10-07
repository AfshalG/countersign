import {
  encodeFunctionData,
  hashTypedData,
  keccak256,
  stringToHex,
  zeroHash,
  type Address,
  type Hex,
} from 'viem';
import { countersignAccountAbi } from '@countersign/chain';
import { accountDomain, formatUsdc, ownerActionTypes } from '@countersign/shared';
import type { WebAuthnAuth } from '../chain/types.js';

/**
 * Judge mode (Slice 9 part 4, D35): an account for a new passkey, set up so that person can try
 * the whole flow with their own Face ID. Only the account's passkey can set its policy, add a
 * supplier or open an order (money rule 8), so the new passkey signs three setup actions; this
 * module fixes what they are, so the challenges shown are the ones checked.
 */

/** Every demo account is created with this salt: one account per passkey. */
export const DEMO_SALT = keccak256(stringToHex('countersign demo account'));

/**
 * No waiting period, so a judge can pay at once; real accounts keep the default (48 hours, D28).
 * Shown on screen: this is the one rule judge mode relaxes.
 */
export const DEMO_WAITING_PERIOD = 0n;

/** The demo supplier, at the address its own website lists (Primus-proven in Slice 2). */
export const KALIBRE = {
  supplierId: keccak256(stringToHex('kalibre-studio')),
  payTo: '0x90f9931B748B26763161a8191C178Fe425C25fEc' as Address,
};

const DAY = 86_400;

export type DemoPlan = {
  policy: {
    agentKey: Address;
    checkerKey: Address;
    perPaymentCap: bigint;
    newAddressCap: bigint;
    newAddressPeriod: bigint;
    waitingPeriod: bigint;
    expiry: bigint;
  };
  supplier: { supplierId: Hex; payTo: Address; active: boolean; proofHash: Hex };
  order: { orderId: Hex; supplierId: Hex; orderHash: Hex; amount: bigint; expiry: bigint };
  /** The three signatures are valid until then. */
  deadline: bigint;
};

/** What the gateway funds a demo account with: twice the order, in USDC base units. */
export const DEMO_FUNDING = 10_000n;

function plan(input: { agentKey: Address; checkerKey: Address; now: number }): DemoPlan {
  const month = BigInt(input.now + 30 * DAY);
  return {
    policy: {
      agentKey: input.agentKey,
      checkerKey: input.checkerKey,
      perPaymentCap: 5_000n, // 0.005 USDC
      newAddressCap: 2_000n, // 0.002 USDC while an address is new
      newAddressPeriod: BigInt(7 * DAY),
      waitingPeriod: DEMO_WAITING_PERIOD,
      expiry: month,
    },
    supplier: { ...KALIBRE, active: true, proofHash: zeroHash },
    order: {
      orderId: keccak256(stringToHex('demo order 001')),
      supplierId: KALIBRE.supplierId,
      orderHash: keccak256(stringToHex('Kalibre Studio quote Q-2210: 50 product photos')),
      amount: 5_000n, // 0.005 USDC
      expiry: month,
    },
    deadline: BigInt(input.now + DAY),
  };
}

type Json = Record<string, Record<string, string | boolean> | string>;

/** Stored as JSON (bigints as strings) and read back exactly. */
export const demoPlan = Object.assign(plan, {
  toJson(p: DemoPlan): Json {
    const strings = (o: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
      ) as Record<string, string | boolean>;
    return {
      policy: strings(p.policy),
      supplier: strings(p.supplier),
      order: strings(p.order),
      deadline: p.deadline.toString(),
    };
  },
  fromJson(j: Json): DemoPlan {
    const o = (k: string) => j[k] as Record<string, string>;
    const policy = o('policy');
    const supplier = j.supplier as Record<string, string | boolean>;
    const order = o('order');
    const big = (v: string | undefined) => BigInt(v ?? '0');
    return {
      policy: {
        agentKey: policy.agentKey as Address,
        checkerKey: policy.checkerKey as Address,
        perPaymentCap: big(policy.perPaymentCap),
        newAddressCap: big(policy.newAddressCap),
        newAddressPeriod: big(policy.newAddressPeriod),
        waitingPeriod: big(policy.waitingPeriod),
        expiry: big(policy.expiry),
      },
      supplier: {
        supplierId: supplier.supplierId as Hex,
        payTo: supplier.payTo as Address,
        active: supplier.active === true,
        proofHash: supplier.proofHash as Hex,
      },
      order: {
        orderId: order.orderId as Hex,
        supplierId: order.supplierId as Hex,
        orderHash: order.orderHash as Hex,
        amount: big(order.amount),
        expiry: big(order.expiry),
      },
      deadline: BigInt(j.deadline as string),
    };
  },
});

/** In this order, at owner nonces 0, 1 and 2: the policy, the supplier, then the order. */
export const SETUP_ACTIONS = ['setPolicy', 'setSupplier', 'approveOrder'] as const;
export type SetupIndex = 0 | 1 | 2;

const PRIMARY = { 0: 'SetPolicy', 1: 'SetSupplier', 2: 'ApproveOrder' } as const;

function messageOf(p: DemoPlan, index: SetupIndex) {
  const tail = { nonce: BigInt(index), deadline: p.deadline };
  if (index === 0) return { ...p.policy, ...tail };
  if (index === 1) return { ...p.supplier, ...tail };
  return { ...p.order, ...tail };
}

const SUMMARY = (p: DemoPlan): Record<SetupIndex, string> => ({
  0: `Let the demo agent pay up to ${formatUsdc(p.policy.perPaymentCap)} USDC per invoice, checked by Countersign`,
  1: `Add Kalibre Studio as a supplier, paid only at ${p.supplier.payTo}`,
  2: `Open an order with Kalibre Studio for ${formatUsdc(p.order.amount)} USDC`,
});

/** One setup action: what the passkey signs (the EIP-712 digest) and what to show. */
export function setupAction(chainId: number, account: Address, p: DemoPlan, index: SetupIndex) {
  const domain = accountDomain(chainId, account);
  const primaryType = PRIMARY[index];
  const message = messageOf(p, index);
  const tail = { nonce: BigInt(index), deadline: p.deadline };
  // One call per action: the typed-data types are checked per primary type.
  const challenge =
    index === 0
      ? hashTypedData({
          domain,
          types: ownerActionTypes,
          primaryType: 'SetPolicy',
          message: { ...p.policy, ...tail },
        })
      : index === 1
        ? hashTypedData({
            domain,
            types: ownerActionTypes,
            primaryType: 'SetSupplier',
            message: { ...p.supplier, ...tail },
          })
        : hashTypedData({
            domain,
            types: ownerActionTypes,
            primaryType: 'ApproveOrder',
            message: { ...p.order, ...tail },
          });
  return {
    action: SETUP_ACTIONS[index],
    nonce: index,
    summary: SUMMARY(p)[index],
    challenge,
    typedData: {
      domain,
      primaryType,
      types: { [primaryType]: ownerActionTypes[primaryType] },
      message: Object.fromEntries(
        Object.entries(message).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]),
      ),
    },
  };
}

/** The account call for one setup action, signed with the passkey. */
export function setupCall(p: DemoPlan, index: SetupIndex, auth: WebAuthnAuth): Hex {
  const nonce = BigInt(index);
  if (index === 0)
    return encodeFunctionData({
      abi: countersignAccountAbi,
      functionName: 'setPolicy',
      args: [p.policy, nonce, p.deadline, auth],
    });
  if (index === 1)
    return encodeFunctionData({
      abi: countersignAccountAbi,
      functionName: 'setSupplier',
      args: [
        p.supplier.supplierId,
        p.supplier.payTo,
        p.supplier.active,
        p.supplier.proofHash,
        nonce,
        p.deadline,
        auth,
      ],
    });
  return encodeFunctionData({
    abi: countersignAccountAbi,
    functionName: 'approveOrder',
    args: [
      p.order.orderId,
      p.order.supplierId,
      p.order.orderHash,
      p.order.amount,
      p.order.expiry,
      nonce,
      p.deadline,
      auth,
    ],
  });
}
