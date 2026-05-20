import { v4 as uuid } from 'uuid';
import type { Logger } from 'pino';
import type { NexusStore } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import { DEFAULT_TEMPLATES, createMailer, renderEmail } from '../lib/email.js';

export interface EmailService {
  enqueue(opts: {
    to: string;
    templateKey: string;
    vars: Record<string, unknown>;
    /** Optional override subject when not using a template. */
    subject?: string;
    /** Optional override body when not using a template. */
    body?: string;
    /** Schedule the message for a future delivery. */
    scheduledAt?: Date;
  }): Promise<void>;
  /** Process the outbox once. Returns count of attempted messages. */
  flushOnce(): Promise<number>;
  startWorker(): { stop: () => void };
  seedTemplates(): Promise<void>;
}

export function createEmailService(
  config: ResolvedConfig,
  store: NexusStore,
  logger: Logger,
): EmailService {
  const mailer = createMailer(config, logger);

  const enqueue: EmailService['enqueue'] = async ({
    to,
    templateKey,
    vars,
    subject,
    body,
    scheduledAt,
  }) => {
    let renderedSubject = subject;
    let renderedBody = body;
    if (!renderedSubject || !renderedBody) {
      const template = await store.email.getTemplate(templateKey);
      if (template) {
        const rendered = renderEmail(
          { subject_template: template.subject_template, body_template: template.body_template },
          vars,
        );
        renderedSubject ??= rendered.subject;
        renderedBody ??= rendered.body;
      } else {
        const defaultTemplate = DEFAULT_TEMPLATES[templateKey];
        if (defaultTemplate) {
          const rendered = renderEmail(
            { subject_template: defaultTemplate.subject, body_template: defaultTemplate.body },
            vars,
          );
          renderedSubject ??= rendered.subject;
          renderedBody ??= rendered.body;
        }
      }
    }
    if (!renderedSubject || !renderedBody) {
      throw new Error(`No template found for ${templateKey} and no subject/body override supplied`);
    }
    await store.email.enqueue({
      id: uuid(),
      to_address: to,
      subject: renderedSubject,
      template_id: templateKey,
      payload: vars,
      status: 'pending',
      attempts: 0,
      last_error: null,
      scheduled_at: (scheduledAt ?? new Date()).toISOString(),
      sent_at: null,
      created_at: new Date().toISOString(),
    });
  };

  const flushOnce = async (): Promise<number> => {
    const now = new Date().toISOString();
    const batch = await store.email.claimBatch(now, 25);
    if (batch.length === 0) return 0;
    let processed = 0;
    for (const row of batch) {
      try {
        await mailer.send({
          to: row.to_address,
          subject: row.subject,
          body: rebuildBody(row.subject, row.payload, row.template_id),
        });
        await store.email.markSent(row.id, new Date().toISOString());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await store.email.markFailed(row.id, row.attempts + 1, msg);
        logger.warn({ err, id: row.id }, 'email send failed');
      }
      processed++;
    }
    return processed;
  };

  const rebuildBody = (
    fallbackSubject: string,
    vars: Record<string, unknown>,
    templateKey: string | null,
  ): string => {
    // If the body wasn't pre-rendered (because the template existed at the time
    // of enqueue) we already stored the rendered subject. Bodies are
    // re-rendered at send time so admins can update templates without losing
    // queued messages.
    if (!templateKey) return fallbackSubject;
    const tmpl = DEFAULT_TEMPLATES[templateKey];
    if (!tmpl) return fallbackSubject;
    return renderEmail({ subject_template: tmpl.subject, body_template: tmpl.body }, vars).body;
  };

  const seedTemplates: EmailService['seedTemplates'] = async () => {
    const existing = await store.email.listTemplates();
    const present = new Set(existing.map((t) => t.key));
    for (const [key, tmpl] of Object.entries(DEFAULT_TEMPLATES)) {
      if (present.has(key)) continue;
      await store.email.upsertTemplate({
        key,
        subject_template: tmpl.subject,
        body_template: tmpl.body,
        enabled: 1,
        updated_at: new Date().toISOString(),
      });
    }
  };

  const startWorker: EmailService['startWorker'] = () => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        await flushOnce();
      } catch (err) {
        logger.error({ err }, 'email worker tick failed');
      }
      if (!stopped) setTimeout(tick, 5000).unref();
    };
    setTimeout(tick, 1500).unref();
    return {
      stop() {
        stopped = true;
      },
    };
  };

  return { enqueue, flushOnce, startWorker, seedTemplates };
}
