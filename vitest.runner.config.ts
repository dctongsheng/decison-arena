import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/runner/tests/**/*.integration.ts'],
    pool: 'forks', minWorkers: 1, maxWorkers: 1, fileParallelism: false,
    testTimeout: 20000, hookTimeout: 30000,
  },
});
