import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Same reasoning as mcp/vitest.config.ts: the verifier is a sibling package that is not
      // published yet, so `package.json` declares the semver it WILL be installed under while the
      // suite resolves the SOURCE — green on a fresh clone, before any link or publish step.
      '@proof-holdings/delegation-verifier': new URL(
        '../delegation-verifier/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
});
