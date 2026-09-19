import { readProductionConfig } from './production-config.ts';
import { startProductionPublisher } from './oauth-server.ts';
import { installShutdownHandlers } from './lifecycle.ts';
import { startSecretPublisher, startPublicPublisher } from './secret-server.ts';
import { ConfigError } from './config-error.ts';

try {
  const config = readProductionConfig(process.env);
  if (process.argv.includes('--check-config')) {
    console.log('CONFIG_VALID');
  } else {
    const app = config.authMode === 'public' ? await startPublicPublisher(config) : config.authMode === 'secret_path' ? await startSecretPublisher(config) : await startProductionPublisher(config);
    installShutdownHandlers(app.close);
    console.log(`PUBLISHER_STARTED profile=${config.profile} publish_enabled=${config.publishEnabled} auth=${config.authMode}`);
  }
} catch (error) {
  // Do not emit URLs, JWTs, Bot API tokens, config values or dependency errors.
  console.error(error instanceof ConfigError ? `CONFIG_INVALID: ${error.message}` : 'STARTUP_FAILED: check port and runtime configuration; see TIMEWEB-NATIVE.md');
  process.exitCode = 1;
}
