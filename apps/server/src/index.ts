import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const app = buildApp({ config, logger: true });
  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  process.stderr.write(`Failed to start: ${String(err)}\n`);
  process.exit(1);
});
