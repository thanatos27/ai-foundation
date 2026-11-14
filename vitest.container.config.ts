import { defineConfig } from 'vitest/config';

/** Builds and runs the container image with Docker (npm run test:container). No provider is contacted. */
export default defineConfig({
  test: {
    include: ['tests/container/**/*.container.test.ts'],
    testTimeout: 120_000,
    // The image build (npm ci, tsc) runs in beforeAll.
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
