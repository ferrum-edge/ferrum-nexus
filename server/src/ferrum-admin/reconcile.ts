import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { EdgeLogger, FerrumAdminClient } from './client.js';

/** Best-effort startup prerequisites; a gateway outage must not prevent portal startup. */
export async function reconcileGateway(
  edge: FerrumAdminClient,
  audit: AuditService,
  logger: EdgeLogger,
): Promise<void> {
  await edge.ensureNamespace('Managed by Ferrum Nexus');
  try {
    const created = await edge.ensureMetricsConfig();
    if (!created) return;
    // Log before auditing so a database failure cannot hide a completed Edge write.
    logger.warn(
      { namespace: edge.namespace, pluginConfigId: created.id },
      'Created the Ferrum Edge namespace-global metrics config',
    );
    await audit.record(
      SYSTEM_ACTOR,
      AuditAction.GATEWAY_METRICS_ENABLE,
      { type: 'plugin_config', id: created.id },
      { namespace: edge.namespace },
    );
  } catch (error) {
    logger.warn(
      { namespace: edge.namespace, error: error instanceof Error ? error.message : String(error) },
      'Could not reconcile the Ferrum Edge metrics config; retry on restart',
    );
  }
}
