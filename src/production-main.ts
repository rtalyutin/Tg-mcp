import { readProductionConfig } from './production-config.ts';
import { startProductionPublisher } from './oauth-server.ts';
import { installShutdownHandlers } from './lifecycle.ts';

try {
  const config = readProductionConfig(process.env);
  if (process.argv.includes('--check-config')) {
    console.log('CONFIG_VALID');
  } else {
    const app = await startProductionPublisher(config);
    installShutdownHandlers(app.close);
    console.log(`PUBLISHER_STARTED profile=${config.profile} publish_enabled=${config.publishEnabled}`);
  }
} catch {
  // Do not emit URLs, JWTs, Bot API tokens, config values or dependency errors.
  console.error('STARTUP_FAILED: check required configuration using OAUTH-SETUP.md');
  process.exitCode = 1;
}
