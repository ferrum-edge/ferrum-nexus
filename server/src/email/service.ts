import { v4 as uuid } from 'uuid';
import type { Logger } from 'pino';
import type { NexusStore } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import { DEFAULT_TEMPLATES, createMailer, renderEmail } from '../lib/email.js';
import { decryptSetting } from '../lib/crypto.js';

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
    /**
     * Optional dedup key. A second enqueue with the same key returns without
     * inserting (or throwing). Use for retried request handlers, mass-email
     * campaigns, and any other path that may be invoked more than once for
     * the same logical message.
     */
    idempotencyKey?: string;
    /** Extra SMTP headers to add to the outgoing message (e.g. List-Unsubscribe). */
    headers?: Record<string, string>;
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
  let mailer = createMailer(config, logger);

  const resolveMailer = async () => {
    const smtpHost = await store.settings.get<string>('smtpHost');
    const host = smtpHost ?? config.email.smtpHost;
    const from = (await store.settings.get<string>('emailFrom')) ?? config.email.from;
    const port = (await store.settings.get<number>('smtpPort')) ?? config.email.smtpPort;
    const username = (await store.settings.get<string>('smtpUsername')) ?? config.email.smtpUsername;
    const secure =
      ((await store.settings.get<boolean>('smtpSecure')) ?? config.email.smtpSecure) === true;
    const encPassword = await store.settings.get<string>('smtpPasswordEnc');
    const password = encPassword
      ? decryptSetting(encPassword, config.secretKey)
      : config.email.smtpPassword;

    const resolved: ResolvedConfig = {
      ...config,
      email: { from, smtpHost: host, smtpPort: port, smtpUsername: username, smtpPassword: password, smtpSecure: secure },
    };
    mailer = createMailer(resolved, logger);
    return { mailer, from };
  };

  const enqueue: EmailService['enqueue'] = async ({
    to,
    templateKey,
    vars,
    subject,
    body,
    scheduledAt,
    idempotencyKey,
    headers,
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
      idempotency_key: idempotencyKey ?? null,
      headers: headers ?? null,
    });
  };

  const flushOnce = async (): Promise<number> => {
    const now = new Date().toISOString();
    const batch = await store.email.claimBatch(now, 25);
    if (batch.length === 0) return 0;
    const { mailer: currentMailer } = await resolveMailer();
    let processed = 0;
    for (const row of batch) {
      try {
        await currentMailer.send({
          to: row.to_address,
          subject: row.subject,
          body: await rebuildBody(row.subject, row.payload, row.template_id),
          headers: row.headers ?? undefined,
        });
        await store.email.markSent(row.id, new Date().toISOString());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const nextAttempts = row.attempts + 1;
        await store.email.markFailed(row.id, nextAttempts, msg);
        // Once a message hits the max retry threshold it sits in the DLQ
        // until an admin re-queues it. Surface that at `error` level so it
        // shows up in alerting, not just routine warning noise.
        if (nextAttempts >= 5) {
          logger.error({ err, id: row.id, to: row.to_address }, 'email moved to DLQ');
        } else {
          logger.warn({ err, id: row.id, attempts: nextAttempts }, 'email send failed');
        }
      }
      processed++;
    }
    return processed;
  };

  const rebuildBody = async (
    fallbackSubject: string,
    vars: Record<string, unknown>,
    templateKey: string | null,
  ): Promise<string> => {
    if (!templateKey) return fallbackSubject;
    const dbTemplate = await store.email.getTemplate(templateKey);
    if (dbTemplate) {
      return renderEmail(
        { subject_template: dbTemplate.subject_template, body_template: dbTemplate.body_template },
        vars,
      ).body;
    }
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
