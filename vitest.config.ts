import { existsSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

// The sibling verifier package sits next to this one only in the monorepo. The public mirror
// (ProofHoldings/delegation-self-refusal) has none, so there the suite resolves the published verifier
// `npm ci` installs — the one a publisher's install runs on. Keyed on the package rather than on its
// entry point, so that inside the monorepo a moved `src/index.ts` still fails to resolve, loudly.
const IN_MONOREPO = existsSync(new URL('../delegation-verifier/package.json', import.meta.url));
// Suites that read outside this package — the verifier's own source and test helpers (the one module
// instance whose JWKS cache and clock they reset), or the shared gate fixtures under `sdks/shared/` —
// which the public mirror does not have; there they are left out. In the monorepo they run in the
// self-refusal-tests job, on every pull request that changes this package or the verifier.
const MONOREPO_ONLY = [
  'src/__tests__/conformance.test.ts',
  'src/__tests__/keyset-store.test.ts',
  'src/__tests__/pickup.test.ts',
];

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...(IN_MONOREPO ? [] : MONOREPO_ONLY)],
    environment: 'node',
  },
  resolve: {
    alias: IN_MONOREPO ? {
      // Same reasoning as mcp/vitest.config.ts: `package.json` installs the PUBLISHED verifier,
      // while the suite resolves this repository's SOURCE — green on a fresh clone with no build,
      // and a verifier change is exercised here before it is published.
      '@proof-holdings/delegation-verifier': new URL(
        '../delegation-verifier/src/index.ts',
        import.meta.url,
      ).pathname,
    } : {},
  },
});
