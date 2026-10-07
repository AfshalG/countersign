import { existsSync } from 'node:fs';

// Local runs read the repo's git-ignored .env (TEST_DATABASE_URL); CI sets it directly.
const envFile = new URL('../../../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);
