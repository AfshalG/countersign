# Slice 0: Repo, tooling, CI, environment

## Status

**DONE (6 Oct 2026).** Approved by Afshal ("ok", S0-1 to S0-5). Built on `chore/slice-00-tooling`, CI green, merged into `development` as `c38c223`.

## Goal

When this slice is done, anyone on the team can clone the repo, run three commands and get a green build: TypeScript type-checked, linted and tested, contracts compiled and fuzz-tested. CI runs the same checks plus a secret scan on every push. Every later slice starts from here without setting anything up.

## Prerequisites

- Repo created, `development` branch pushed. ✅ (6 Oct)
- **On each laptop (Afshal, Roshan, Sophie):**
  - **Node 24 LTS.** Afshal's laptop has Node 23.6, which Vitest 5 does not support (it needs Node 22.12+, 24 or 26+). Install 24 with `nvm install 24` or `brew install node@24`.
  - **pnpm**, through Corepack: `corepack enable`. The version is pinned in `package.json`, so nobody installs it by hand.
  - **Foundry:** `curl -L https://foundry.paradigm.xyz | bash`, then `foundryup`. Not installed on Afshal's laptop yet.
  - **gitleaks** (optional locally, required in CI): `brew install gitleaks`.

## Cross-checked (6 Oct 2026)

| Source | What was checked |
|---|---|
| npm registry | Latest versions and peer ranges for everything pinned below |
| Context7 `/foundry-rs/book` | `[fuzz]` settings and CI profiles in `foundry.toml`; Soldeer install; CI with `foundry-rs/foundry-toolchain` |
| Context7 `/pnpm/action-setup` | v6 reads the pnpm version from `packageManager`; `cache: true` |
| Context7 `/vitest-dev/vitest/v5.0.3` | `test.projects` replaces the deprecated `workspace`; a project config must not merge a root config that defines `projects` (it would nest them) |
| Context7 `/gitleaks/gitleaks` | `gitleaks-action` with `fetch-depth: 0` and `GITHUB_TOKEN` |
| Context7 `/websites/monad_xyz` | Testnet RPCs: `https://testnet-rpc.monad.xyz` (QuickNode, 25 req/s, websocket `wss://testnet-rpc.monad.xyz`), Ankr (no websocket), Monad Foundation (no `eth_getLogs`). Explorer `https://testnet.monadexplorer.com`. Monad's Foundry guide sets `chain_id = 10143` and `metadata_hash = "none"` |
| GitHub releases | `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.1.0, `foundry-rs/foundry-toolchain` v1.9.1, `gitleaks/gitleaks-action` v3.0.0, Foundry v1.8.5, OpenZeppelin Contracts v5.7.0 |

Not checked here, left to the slice that needs it: the `evm_version` Monad needs for the P256 precompile (Slice 1), Drizzle (Slice 6), Next.js PWA setup (Slices 7 and 11).

## Design considerations

**1. TypeScript 6.0, not 7.0.** TypeScript 7.0.2 (the Go rewrite) is the npm `latest`, but `typescript-eslint` 8.71 supports only `>=4.8.4 <6.1.0`. Without it, ESLint can't read TypeScript. So: TypeScript **6.0.3**. Revisit when typescript-eslint supports 7.

**2. Node 24 LTS, pinned.** `.nvmrc` says `24`; `engines.node` says `>=24 <25`. CI uses the same. Vitest 5 rules out Node 23.

**3. One pnpm workspace, folders created only when their slice starts.** The layout in CLAUDE.md is the target. Slice 0 creates only the root, `packages/shared` and `contracts/`. The apps and services get their folders in their own slices, so nobody inherits empty scaffolding that may be wrong. *Alternative:* scaffold every folder now. Rejected: Next.js and Hono choices are made in Slices 6, 7 and 11.

**4. OpenZeppelin through Soldeer, not git submodules.** Foundry supports both. Soldeer pins the version in `foundry.toml` and keeps `dependencies/` out of git, so nobody needs `git submodule update` and CI needs no `submodules: recursive`. OpenZeppelin 5.7.0 is on the Soldeer registry (uploaded 29 Jul 2026). *Fallback:* `forge install OpenZeppelin/openzeppelin-contracts@v5.7.0` if Soldeer gives trouble.

**5. Contracts stay out of pnpm.** `contracts/` is a plain Foundry project. The root `pnpm test:contracts` script calls `forge test` there, so one command still runs everything.

**6. The first real code is the environment loader, because it guards money.** A missing or wrong setting (a mainnet chain ID, a blank checker key) must stop a service at start-up, not halfway through a payment. `packages/shared/src/env.ts` validates with zod, reports **every** missing or invalid name at once, and **never prints a value**, so a key can't land in a log. This is CLAUDE.md money rule 1 (fail closed) applied to start-up.

**7. CI: three jobs.**
- `typescript`: install, typecheck, lint, format check, test.
- `contracts`: `forge fmt --check`, `forge build`, `forge test` with the `ci` profile (more fuzz runs).
- `secrets`: gitleaks over the full history.

Runs on every push to any branch and on pull requests into `development` and `main`.

**8. Two GitHub settings (free on a public repo):**
- **Secret scanning with push protection.** GitHub refuses a push containing a known key format before it lands. This and gitleaks cover different cases.
- **Branch protection on `main`:** no direct pushes and no force pushes; changes only through a pull request. It enforces "never push to main" for all three of us, not just by habit.

**9. Formatting and linting.** ESLint 10 flat config with `typescript-eslint` (strict, type-checked) and `eslint-config-prettier`; Prettier 3; `forge fmt` for Solidity.

## Pinned versions

| Tool | Version | Note |
|---|---|---|
| Node | 24 LTS (24.21.0 today) | `.nvmrc`, `engines` |
| pnpm | 12.9.1 | `packageManager` field |
| TypeScript | 6.0.3 | Not 7.0; see consideration 1 |
| Vitest, @vitest/coverage-v8 | 5.0.3 | |
| ESLint | 10.12.0 | flat config |
| typescript-eslint | 8.71.1 | |
| eslint-config-prettier | 10.1.8 | |
| Prettier | 3.9.9 | |
| zod | 4.6.5 | |
| @types/node | 24.19.1 | |
| Foundry | 1.8.5 | `foundryup` |
| OpenZeppelin Contracts | 5.7.0 | Soldeer |

## What gets built

```
countersign/
├── package.json             workspace root: scripts, devDependencies, packageManager, engines
├── pnpm-workspace.yaml      packages/*, services/*, apps/*
├── .nvmrc                   24
├── tsconfig.base.json       strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext
├── eslint.config.js         flat config
├── .prettierrc.json, .prettierignore
├── vitest.config.ts         test.projects: ['packages/*', 'services/*', 'apps/*']
├── .env.example             names only, grouped by the slice that first needs them
├── .github/workflows/ci.yml typescript, contracts, secrets
├── packages/shared/
│   ├── package.json         @countersign/shared
│   ├── tsconfig.json
│   ├── src/env.ts           loadEnv(schema, source)
│   ├── src/index.ts
│   └── test/env.test.ts
└── contracts/
    ├── foundry.toml         solc pinned, [fuzz] runs 256 (default), [profile.ci.fuzz] runs 5000, Soldeer deps, Monad testnet RPC alias
    ├── src/.gitkeep
    └── test/Toolchain.t.sol
```

**`packages/shared/src/env.ts`**

```ts
export class EnvError extends Error {
  readonly problems: ReadonlyArray<{ name: string; issue: 'missing' | 'invalid' }>;
}
export function loadEnv<S extends z.ZodObject>(schema: S, source?: Record<string, string | undefined>): z.infer<S>;
export const monadChainId: z.ZodType<10143 | 143>; // parses the string, accepts only these two
```

- `source` defaults to `process.env`; tests pass their own object.
- Empty strings count as missing.
- The error message lists names and `missing` or `invalid`, never a value.

**`.env.example`** (names only; values come from each person's `.env`, never from git)

```
# Chain (Slice 1)
MONAD_CHAIN_ID=10143
MONAD_RPC_URL=
MONAD_WS_URL=
USDC_ADDRESS=

# Deployer and relayers (Slices 1, 3, 6)
DEPLOYER_PRIVATE_KEY=
RELAYER_PRIVATE_KEYS=

# Checker (Slice 10). Only the checker service reads this.
CHECKER_PRIVATE_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=

# Attestation (Slice 2)
PRIMUS_APP_ID=
PRIMUS_APP_SECRET=

# Data (Slice 6)
DATABASE_URL=
```

**`contracts/test/Toolchain.t.sol`:** proves the toolchain end to end. It imports OpenZeppelin's `P256` (which compiles only if Soldeer and the remappings work) and runs a fuzz test: a random signature over a random hash does not verify against a fixed public key. Nothing in `src/` yet; the account and vault contracts arrive in Slice 5.

## Tests first

Written and seen failing before `env.ts` exists:

1. `loadEnv` returns typed values when every variable is present and valid.
2. One missing variable: throws `EnvError` whose `problems` names it as `missing`.
3. Three problems at once (two missing, one invalid): all three are reported in one error, not just the first.
4. An empty string counts as missing.
5. **No value leaks:** with `CHECKER_PRIVATE_KEY=0xdeadbeef…` and another variable invalid, the error message and `problems` don't contain `deadbeef`.
6. `monadChainId` accepts `"10143"` and `"143"`, rejects `"1"`, `"abc"` and `""`.
7. `source` defaults to `process.env`.

Contracts: `testFuzz_RandomSignatureDoesNotVerify(bytes32 hash, bytes32 r, bytes32 s)` passes with 256 runs locally and 5,000 in CI.

## Git workflow

```bash
git checkout development && git pull
git checkout -b chore/slice-00-tooling
# commits:
#   chore: pnpm workspace, TypeScript, ESLint, Prettier, Vitest
#   test: failing tests for loadEnv
#   feat: loadEnv validates settings and never prints a value
#   chore: Foundry project with OpenZeppelin through Soldeer
#   ci: typescript, contracts and secret-scan jobs
#   docs: .env.example and setup steps in README
git push -u origin chore/slice-00-tooling
# CI green → merge into development, delete the branch
```

GitHub settings (secret scanning with push protection, branch protection on `main`) are applied with `gh api` after CI is green, so the required checks exist.

No AI co-author or attribution lines in any commit.

## Manual testing

1. Fresh clone, `corepack enable && pnpm install`: installs with no peer-dependency warnings.
2. `pnpm typecheck`, `pnpm lint`, `pnpm test`: all pass; Vitest reports 7 tests in `@countersign/shared`.
3. `pnpm test:contracts`: Soldeer installs OpenZeppelin 5.7.0; the fuzz test passes 256 runs.
4. Put a fake key such as `ghp_` followed by 36 letters into a file on a scratch branch and push: GitHub's push protection blocks it. Delete the branch.
5. Push a branch with a type error: the `typescript` job fails. Revert.
6. `git push origin main` from a local commit: rejected by branch protection.
7. Roshan and Sophie each run steps 1–3 on their own laptops.

## Commit

The six commits above, merged into `development` with `--no-ff` once CI is green. README gains a "Getting started" section with the prerequisites and three commands.

## Next

Slice 1: a passkey signature verified on Monad testnet through the P256 precompile. It needs a funded testnet deployer wallet (faucet) in `.env`, and settles which `evm_version` Monad needs.

## Decisions for Afshal in this slice

| # | Decision | Recommendation |
|---|---|---|
| S0-1 | TypeScript version | 6.0.3, because ESLint's TypeScript support doesn't cover 7 yet |
| S0-2 | Node | 24 LTS on all three laptops and in CI (Afshal: upgrade from 23.6) |
| S0-3 | OpenZeppelin install | Soldeer, with git submodules as the fallback |
| S0-4 | Folders | Only `packages/shared` and `contracts/` now; the rest in their own slices |
| S0-5 | GitHub settings | Turn on secret-scanning push protection and branch protection on `main` |

## What was built

- **Tools installed on Afshal's laptop:** Node 24.21.0 (nvm, now the default), pnpm 12.9.1 through Corepack, Foundry 1.8.5, gitleaks 8.30.1.
- **Root workspace:** `package.json` (`pnpm check` runs typecheck, lint, format check and tests), `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, Prettier, `vitest.config.ts` with `test.projects`, `.nvmrc`.
- **`@countersign/shared`:** `loadEnv`, `EnvError`, `monadChainId`. 12 tests (the 7 cases, with the chain-ID cases expanded by `it.each`), written first and seen failing 12 of 12.
- **`contracts/`:** Foundry project, OpenZeppelin 5.7.0 and forge-std 1.17.0 through Soldeer, `Toolchain.t.sol` (2 tests; fuzz 256 runs locally, 5,000 in CI).
- **CI** (`.github/workflows/ci.yml`): `typescript`, `contracts`, `secrets` jobs, all green on the first run.
- **`.env.example`**, README "Getting started", pinned versions and commands in `CLAUDE.md`.
- **GitHub:** secret scanning and push protection on. `main` protected: changes only through a pull request with the three CI checks passing, no force pushes, no deletion, and the rules apply to admins too.

## Adapted from spec

1. **No separate failing-test commit.** The tests were written and seen failing first, but committed together with the code, because a commit with failing tests breaks "never commit broken code" and CI.
2. **`foundry.toml` compiler settings.** OpenZeppelin's `P256` fails with "stack too deep" unless `via_ir` and the optimizer are on, so both are on. `solc` pinned to 0.8.37. Monad's Foundry guide uses `metadata` and `metadata_hash`, which Foundry 1.8.5 reports as unknown; `bytecode_hash = "none"` is the current name.
3. **forge-std added through Soldeer** (1.17.0). Soldeer's generated remapping for it missed `src/`, so `remappings.txt` is hand-fixed and `remappings_regenerate = false` keeps it. Imports use version-free prefixes (`@openzeppelin-contracts/...`).
4. **gitleaks needs no license** for a repo under a personal account (its README).
5. **Branch protection goes further than planned:** it also requires the three CI checks and applies to admins. A pull request needs no approving review, so one person can still merge `development` into `main` at a milestone.
6. GitHub returned 500 errors twice (one push, one settings call). Both worked on retry.

**Manual tests:** 1–3 pass locally and in CI; 5 is covered by CI running on every push. Not run: 4 (pushing a fake key; push protection is confirmed on through the API instead) and 6 (pushing to `main` on purpose; protection confirmed through the API). 7 waits for Roshan and Sophie.

---

