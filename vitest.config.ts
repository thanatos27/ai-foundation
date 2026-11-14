import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Real Todoist / Google Calendar / Notion / Obsidian access: run with `npm run test:integration`.
    // The container image (Docker): run with `npm run test:container`.
    exclude: ['tests/integration/**', 'tests/container/**'],
  },
});
