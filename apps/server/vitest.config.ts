import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      // index.ts and migrate-history.ts's main() are process entrypoints -
      // argv, real file/pool handles, process.exit - not meaningfully unit
      // testable. Their logic is factored out and tested: migrateRows() and
      // parseArgs() in migrate-history.test.ts.
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/migrate-history.ts'],
      thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
    },
  },
});
