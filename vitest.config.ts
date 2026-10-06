import { defineConfig } from 'vitest/config';

// Each workspace folder is its own Vitest project. Project configs must not
// merge this file: in Vitest 5 a config that defines `projects` nests them.
export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'apps/*'],
  },
});
