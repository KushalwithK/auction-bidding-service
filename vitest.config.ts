import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All test files share one database, so run them one after another.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
