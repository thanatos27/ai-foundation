import { defineConfig } from 'vitest/config';

/** Tests against the real Todoist / Google Calendar APIs, skipped unless AI_FOUNDATION_INTEGRATION=1. */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Shares one Todoist account and calendar: run files one at a time.
    fileParallelism: false,
  },
});
