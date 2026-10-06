import { z } from 'zod';

export type EnvProblem = { name: string; issue: 'missing' | 'invalid' };

/**
 * Thrown when settings are missing or invalid. Carries names only: a value
 * (a private key, an API key) must never reach a log through this error.
 */
export class EnvError extends Error {
  readonly problems: readonly EnvProblem[];

  constructor(problems: readonly EnvProblem[]) {
    const list = problems.map((p) => `${p.name} (${p.issue})`).join(', ');
    super(`Invalid environment: ${list}`);
    this.name = 'EnvError';
    this.problems = problems;
  }
}

/**
 * Validates settings against `schema` and fails closed at start-up, so a bad
 * setting stops a service before it can touch a payment. Every problem is
 * reported at once. Empty strings count as missing, because an `.env` line
 * like `CHECKER_PRIVATE_KEY=` is a forgotten value, not a real one.
 */
export function loadEnv<S extends z.ZodObject>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.output<S> {
  const names = Object.keys(schema.shape);
  const present: Record<string, string> = {};
  const missing = new Set<string>();

  for (const name of names) {
    const value = source[name];
    if (value === undefined || value === '') missing.add(name);
    else present[name] = value;
  }

  const result = schema.safeParse(present);
  if (missing.size === 0 && result.success) return result.data;

  // zod's own messages are dropped on purpose: only the variable name is kept.
  const invalid = new Set<string>();
  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = String(issue.path[0] ?? '');
      if (name !== '' && !missing.has(name)) invalid.add(name);
    }
  }

  const problems: EnvProblem[] = names.flatMap((name): EnvProblem[] => {
    if (missing.has(name)) return [{ name, issue: 'missing' }];
    if (invalid.has(name)) return [{ name, issue: 'invalid' }];
    return [];
  });
  throw new EnvError(problems);
}

/** Monad testnet (10143) or mainnet (143). Anything else is refused. */
export const monadChainId = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.union([z.literal(10143), z.literal(143)]));
