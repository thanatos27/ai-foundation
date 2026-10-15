import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Todoist / Google Calendar / Notion / Obsidian access: run with `npm run test:integration`.
    exclude: ['tests/integration/**'],
  },
});
