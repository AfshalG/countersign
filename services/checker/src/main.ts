import { serve } from '@hono/node-server';
import { z } from 'zod';
import type { Hex } from 'viem';
import { loadEnv } from '@countersign/shared';
import { createApp } from './app.js';
import { FallbackModel, JevModel, SonnetModel } from './model.js';
import { keySigner } from './sign.js';

/**
 * The checker service (Slice 10). It alone holds the checker key: the gateway calls it with its
 * own token and never signs a release itself. Fail closed on settings (Slice 0's loader).
 */
const settings = loadEnv(
  z.object({
    CHECKER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    CHECKER_TOKEN: z.string().min(24),
    OPENROUTER_API_KEY: z.string().min(20),
    PORT: z.coerce.number().int().default(8080),
  }),
);
const model = new FallbackModel([
  new JevModel(settings.OPENROUTER_API_KEY),
  // Needs OpenRouter credits; without them it fails, and the check holds (money rule 1).
  new SonnetModel(settings.OPENROUTER_API_KEY),
]);
const signer = keySigner(settings.CHECKER_PRIVATE_KEY as Hex);
const app = createApp({ token: settings.CHECKER_TOKEN, model, signer });
const server = serve({ fetch: app.fetch, port: settings.PORT }, (info) => {
  console.log(
    `checker listening on ${String(info.port)}; signs as ${signer.address}; model ${model.name}`,
  );
});
const stop = () => {
  server.close(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
