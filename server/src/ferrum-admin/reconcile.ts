import { AuditAction, SYSTEM_ACTOR, type AuditService } from '../audit/service.js';
import type { EdgeLogger, FerrumAdminClient } from './client.js';
import { namespaceUnservedMessage } from './namespace.js';

/**
 * Seed the namespace-routability verdict from the gateway's own health, and
 * say so loudly when the two sides disagree (ferrum-nexus#230).
 *
 * Nothing else probes until `GET /api/health` is called, so without this a
 * portal nobody monitors would publish into an unrouted namespace for as long
 * as it took someone to notice the `404`s. `probe()` never throws and an
 * unreachable gateway asserts nothing: the verdict simply stays unknown, and
 * the metrics reconciliation below reports the outage anyway.
 *
 * @returns whether the gateway routes the namespace Nexus publishes into
 */
export async function checkNamespaceRoutability(
  edge: FerrumAdminClient,
  logger: EdgeLogger,
): Promise<boolean> {
  await edge.probe();
  const routing = edge.namespaceMonitor.routing();
  if (!routing.unserved) return true;
  logger.error(
    {
      namespace: routing.configured,
      activeNamespace: routing.active,
      servingScope: routing.serving_scope,
    },
    `MISCONFIGURED NAMESPACE: ${namespaceUnservedMessage(routing)}`,
  );
  return false;
}

/** Best-effort startup prerequisites; a gateway outage must not prevent portal startup. */
export async function reconcileGateway(
  edge: FerrumAdminClient,
  audit: AuditService,
  logger: EdgeLogger,
): Promise<void> {
  await checkNamespaceRoutability(edge, logger);
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
