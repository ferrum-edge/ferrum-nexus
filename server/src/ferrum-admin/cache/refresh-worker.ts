import type { Logger } from 'pino';
import type { CachingFerrumAdminClient } from './caching-client.js';

export function startCacheRefreshWorker(
  client: CachingFerrumAdminClient,
  intervalHours: number,
  logger: Logger,
): { stop: () => void } {
  let stopped = false;
  const intervalMs = Math.max(intervalHours, 0.001) * 60 * 60 * 1000;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await client.refresh();
      logger.info('Ferrum admin cache refreshed');
    } catch (err) {
      logger.warn({ err }, 'Ferrum admin cache refresh failed');
    }
    if (!stopped) setTimeout(tick, intervalMs).unref();
  };

  setTimeout(tick, intervalMs).unref();
  return {
    stop() {
      stopped = true;
    },
  };
}
