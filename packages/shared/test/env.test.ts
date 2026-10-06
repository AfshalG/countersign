import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EnvError, loadEnv, monadChainId } from '../src/env.js';

const schema = z.object({
  MONAD_CHAIN_ID: monadChainId,
  MONAD_RPC_URL: z.url(),
  CHECKER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
});

const secret = `0x${'deadbeef'.repeat(8)}`;

const valid = {
  MONAD_CHAIN_ID: '10143',
  MONAD_RPC_URL: 'https://testnet-rpc.monad.xyz',
  CHECKER_PRIVATE_KEY: secret,
};

function problemsOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).problems;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('returns typed values when every variable is present and valid', () => {
    const env = loadEnv(schema, valid);
    expect(env.MONAD_CHAIN_ID).toBe(10143);
    expect(env.MONAD_RPC_URL).toBe('https://testnet-rpc.monad.xyz');
  });

  it('names a single missing variable', () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.MONAD_RPC_URL;
    expect(problemsOf(() => loadEnv(schema, rest))).toEqual([
      { name: 'MONAD_RPC_URL', issue: 'missing' },
    ]);
  });

  it('reports every problem at once, not just the first', () => {
    const problems = problemsOf(() => loadEnv(schema, { MONAD_CHAIN_ID: '1' }));
    expect(problems).toHaveLength(3);
    expect(problems).toEqual(
      expect.arrayContaining([
        { name: 'MONAD_CHAIN_ID', issue: 'invalid' },
        { name: 'MONAD_RPC_URL', issue: 'missing' },
        { name: 'CHECKER_PRIVATE_KEY', issue: 'missing' },
      ]),
    );
  });

  it('treats an empty string as missing', () => {
    expect(problemsOf(() => loadEnv(schema, { ...valid, MONAD_RPC_URL: '' }))).toEqual([
      { name: 'MONAD_RPC_URL', issue: 'missing' },
    ]);
  });

  it('never puts a value in the error', () => {
    try {
      loadEnv(schema, { ...valid, MONAD_RPC_URL: 'not a url' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      const e = error as EnvError;
      const everything = `${e.message} ${JSON.stringify(e.problems)} ${String(e.stack)}`;
      expect(everything).not.toContain('deadbeef');
      expect(everything).not.toContain('not a url');
      expect(e.problems).toEqual([{ name: 'MONAD_RPC_URL', issue: 'invalid' }]);
    }
  });

  describe('defaults to process.env', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = saved;
    });

    it('reads process.env when no source is given', () => {
      process.env = { ...saved, ...valid };
      expect(loadEnv(schema).MONAD_CHAIN_ID).toBe(10143);
    });
  });
});

describe('monadChainId', () => {
  it.each([
    ['10143', 10143],
    ['143', 143],
  ])('accepts %s', (raw, parsed) => {
    expect(monadChainId.parse(raw)).toBe(parsed);
  });

  it.each(['1', 'abc', '', '10143.0'])('rejects %j', (raw) => {
    expect(monadChainId.safeParse(raw).success).toBe(false);
  });
});
