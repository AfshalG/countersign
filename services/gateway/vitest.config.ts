import { defineProject } from 'vitest/config';

// Database tests share one Postgres and reset it, so this project's files run one at a time.
export default defineProject({
  test: {
    setupFiles: ['./test/setup.ts'],
    fileParallelism: false,
  },
});
