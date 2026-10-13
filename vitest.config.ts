import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Todoist / Google Calendar calls: run with `npm run test:integration`.
    exclude: ['tests/integration/**'],
  },
});
