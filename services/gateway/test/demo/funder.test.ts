import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { USDC } from '@countersign/chain';
import { WalletFunder } from '../../src/demo/funder.js';
import { FakeSender } from '../fakes.js';

const TO = '0x1111111111111111111111111111111111111111';

describe('the demo funding wallet', () => {
  it('sends USDC transfers one at a time with consecutive nonces', async () => {
    const sender = new FakeSender();
    const funder = new WalletFunder(generatePrivateKey(), sender, 10143);
    sender.chainNonces.set(funder.address.toLowerCase(), 7);
    await Promise.all([funder.sendUsdc(TO, 10_000n), funder.sendUsdc(TO, 5_000n)]);
    const txs = sender.sent.map((s) => parseTransaction(s.raw));
    expect(txs.map((t) => t.nonce)).toEqual([7, 8]);
    expect(txs[0]?.to?.toLowerCase()).toBe(USDC.toLowerCase());
    const { args } = decodeFunctionData({ abi: erc20Abi, data: txs[0]?.data as Hex });
    expect(args).toEqual([TO, 10_000n]);
  });

  it('reads its nonce again after a refused send', async () => {
    const sender = new FakeSender();
    const funder = new WalletFunder(generatePrivateKey(), sender, 10143);
    sender.reply = () => ({ error: 'insufficient funds', retry: false });
    await expect(funder.sendUsdc(TO, 1n)).rejects.toThrow(/refused/);
    sender.reply = () => 'accepted';
    sender.chainNonces.set(funder.address.toLowerCase(), 3);
    await funder.sendUsdc(TO, 1n);
    expect(parseTransaction(sender.sent.at(-1)?.raw as Hex).nonce).toBe(3);
  });
});
