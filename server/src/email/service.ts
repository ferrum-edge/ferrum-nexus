/**
 * Transactional email: template resolution, SMTP settings and the outbox.
 *
 * Transactional messages are rendered here and inserted into `email_outbox`;
 * the {@link ../email/outbox-worker.js outbox worker} drains the queue out of band. That keeps a slow or broken SMTP server
 * from turning an approval into a 502, and gives retries a home. The admin's
 * SMTP configuration probe sends inline through `sendTest`.
 *
 * SMTP configuration is layered: the environment (`NEXUS_SMTP_*`) supplies the
 * deployment default and the `smtp` / `smtp.password` `app_settings` rows
 * override it at runtime, so an admin can point the portal at a different relay
 * without a redeploy. The password is AES-256-GCM encrypted at rest and is
 * never returned by any endpoint. `NEXUS_SMTP_PASSWORD` is only ever presented
 * to the environment's own connection: a stored override that no longer
 * decrypts, or a stored host/port/TLS/username that differs from the
 * environment's, sends no password rather than the environment's.
 *
 * `enqueue` is at-most-once when given an `idempotencyKey`: a second call with
 * the same key returns the existing row and inserts nothing.
 */

import { Readable } from 'node:stream';

import nodemailer from 'nodemailer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';

import type { EmailTemplateKey } from '@ferrum-nexus/shared';

import {
  readBranding,
  readEncryptedSettingState,
  readStoredSmtp,
  smtpConnectionMatchesEnvironment,
  SMTP_PASSWORD_SETTINGS_KEY,
  type StoredSmtpSettings,
} from '../admin/settings-service.js';
import type { NexusConfig } from '../config/index.js';
import { OUTBOX_PRIORITY, type EmailOutboxRecord, type NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import { isBearerTemplate, sealedEnqueueInput } from './sealed-outbox.js';
import {
  isUrlVariable,
  validateRenderedTextLinks,
  validateTemplateLinks,
} from './template-links.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
  escapeHtml,
  renderTemplate,
  type EmailTemplateContent,
  type RenderedEmail,
  type TemplateVars,
} from './templates.js';

/* ── Transport abstraction ──────────────────────────────────────────────── */

/** One outbound message handed to a {@link MailTransport}. */
export interface OutboundMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Minimal mail sink. The default implementation wraps nodemailer; tests inject
 * a recording fake so no socket is ever opened.
 *
 * A `send` that rejects with {@link MailDeliveredUnacknowledgedError} means the
 * relay may already hold the message, so the caller must not retry it.
 */
export interface MailTransport {
  /** Settle only after the operation cannot transmit any more message bytes. */
  send(mail: OutboundMail, options?: { deadline?: number }): Promise<void>;
  close?(): Promise<void> | void;
}

/**
 * The attempt ended without an answer, but the relay may already have the mail.
 *
 * SMTP hands a message over at the end-of-data marker: once the whole body has
 * been written, a timeout, a reset or an enforced deadline says nothing about
 * whether the relay queued it. Retrying such an attempt is what delivers a
 * second copy, so the outbox parks the row instead — see
 * `OUTBOX_DELIVERED_UNACKNOWLEDGED`.
 */
export class MailDeliveredUnacknowledgedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailDeliveredUnacknowledgedError';
  }
}

/** True when `error` means the relay may already hold the message. */
export function isDeliveredUnacknowledged(error: unknown): boolean {
  return error instanceof MailDeliveredUnacknowledgedError;
}

/**
 * Builds the transport used for one delivery attempt, or `null` when SMTP is
 * not configured — in which case the worker leaves the queue untouched instead
 * of burning retries on mail it cannot possibly send.
 */
export type MailTransportFactory = () => Promise<MailTransport | null>;

/** Fully resolved SMTP settings: environment defaults with `app_settings` on top. */
export interface ResolvedSmtpSettings {
  host: string | null;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  /** RFC 5322 `From` header. */
  from: string;
}

/**
 * Nodemailer's per-phase timeouts, pinned well below its own defaults (2 min /
 * 30 s / 10 min).
 *
 * They are worth having, but they do **not** compose into a total: `socketTimeout`
 * measures inactivity *between* reads, so a relay that answers every command
 * just inside it holds one `send` open for as long as it likes. That is why the
 * total is enforced separately by {@link SMTP_SEND_BUDGET_MS}.
 */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 30_000;

/**
 * Hard ceiling on one delivery attempt, in milliseconds.
 *
 * The owned SMTP connection and MIME source are cancelled at this deadline
 * before `send` settles, so no background operation outlives the claim.
 * The outbox worker re-exports it as `OUTBOX_SEND_BUDGET_MS` and sizes its
 * stale threshold against it — keep the two in step.
 */
export const SMTP_SEND_BUDGET_MS = 60_000;

/** Options for {@link createSmtpTransport}. */
export interface SmtpTransportOptions {
  /** Ceiling on one `send`; defaults to {@link SMTP_SEND_BUDGET_MS}. */
  budgetMs?: number;
}

/** Raised when a `send` outruns its budget. Never escapes this module. */
class SmtpBudgetExceededError extends Error {
  constructor(budgetMs: number) {
    super(`SMTP delivery exceeded its ${budgetMs}ms budget`);
    this.name = 'SmtpBudgetExceededError';
  }
}

/**
 * How far a delivery attempt got before it was cut off.
 *
 * - `unknown` — MIME compilation has not finished;
 * - `before-data` — compiled, but the body was never streamed: the relay cannot
 *   have the message;
 * - `data-in-flight` — the body was partly written. SMTP only accepts a message
 *   at the end-of-data marker, so this is still "not delivered";
 * - `data-sent` — the whole body reached the socket. Whether the relay queued
 *   it is now unknowable without an acknowledgement.
 */
type SendPhase = 'unknown' | 'before-data' | 'data-in-flight' | 'data-sent';

/** A protocol rejection carries the relay's reply; a timeout or a reset does not. */
function hasServerResponse(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const answered = error as { responseCode?: unknown; response?: unknown };
  return typeof answered.responseCode === 'number' || typeof answered.response === 'string';
}

/**
 * Decide whether a failed attempt may nonetheless have delivered the message.
 *
 * A relay that answered — `5xx` on the envelope, `550` after the data — has
 * definitively refused it, so those stay ordinary failures however far the
 * attempt got. Everything else is judged on the phase: only a body that was
 * written in full can be sitting in the relay's queue.
 */
function classifySendFailure(error: unknown, phase: SendPhase): unknown {
  if (hasServerResponse(error)) return error;
  const reason = error instanceof Error ? error.message : String(error);
  if (phase === 'data-sent') {
    return new MailDeliveredUnacknowledgedError(
      `${reason}; the relay may already have the whole message`,
      { cause: error },
    );
  }
  return error;
}

/** Build a Nodemailer MIME renderer and an explicitly cancellable SMTP connection. */
export function createSmtpTransport(
  settings: ResolvedSmtpSettings,
  options: SmtpTransportOptions = {},
): MailTransport {
  const budgetMs = options.budgetMs ?? SMTP_SEND_BUDGET_MS;
  const renderer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'windows',
  });
  let queue: Promise<unknown> = Promise.resolve();
  let cancelCurrent: ((error: Error) => void) | null = null;
  let closed = false;

  function attempt(mail: OutboundMail, deadline: number): Promise<void> {
    let connection: SMTPConnection | null = null;
    let source: Readable | null = null;
    let phase: SendPhase = 'unknown';
    let aborted: Error | null = null;
    let rejectSmtp: ((error: Error) => void) | null = null;
    let timer: NodeJS.Timeout | undefined;

    function cancel(error: Error): void {
      if (aborted) return;
      aborted = error;
      // close() alone gracefully ends a connected socket. Destroy it first to
      // discard unsent DATA, including the TLS socket after STARTTLS. The
      // exported SMTPConnection owns DNS/connect/auth/DATA; close also prevents
      // a DNS callback from opening a connection after cancellation.
      source?.destroy();
      if (connection?._socket) connection._socket.destroy();
      connection?.close();
      rejectSmtp?.(error);
    }

    function checkDeadline(): void {
      if (closed) cancel(new Error('SMTP transport closed'));
      if (Date.now() >= deadline) cancel(new SmtpBudgetExceededError(budgetMs));
      if (aborted) throw aborted;
    }

    cancelCurrent = cancel;
    const work = (async (): Promise<void> => {
      checkDeadline();
      const compiled = await renderer.sendMail({
        from: settings.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
      // Compilation can finish after cancellation. It cannot start SMTP then.
      checkDeadline();
      if (!Buffer.isBuffer(compiled.message)) {
        throw new Error('SMTP MIME renderer returned no buffer');
      }
      phase = 'before-data';
      connection = new SMTPConnection({
        host: settings.host ?? '',
        port: settings.port,
        secure: settings.secure,
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      });
      // Nodemailer only installs this stream after the relay accepts DATA.
      // Its readable end includes the SMTP terminator, unlike the MIME source
      // which Nodemailer also drains on envelope rejection. This narrow view
      // of the pinned client's internal stream is covered by real relay tests.
      const smtp = connection as SMTPConnection & { _currentDataStream?: Readable | false };
      await new Promise<void>((resolve, reject) => {
        rejectSmtp = reject;
        let finished = false;
        const finish = (error?: Error | null): void => {
          if (finished) return;
          finished = true;
          if (aborted) reject(aborted);
          else if (error) reject(error);
          else resolve();
        };
        smtp.once('error', finish);
        smtp.once('end', () => finish(new Error('SMTP connection closed without acknowledgement')));
        const send = (): void => {
          try {
            checkDeadline();
            source = Readable.from([compiled.message]);
            source.once('resume', () => {
              if (smtp._currentDataStream) phase = 'data-in-flight';
            });
            source.once('end', () => {
              const data = smtp._currentDataStream;
              if (!data) return;
              // Check again before SMTP writes the end-of-data marker. A long
              // event-loop pause can delay the deadline's timer past recovery.
              if (Date.now() >= deadline) {
                cancel(new SmtpBudgetExceededError(budgetMs));
                return;
              }
              data.once('end', () => {
                phase = 'data-sent';
              });
            });
            smtp.send(compiled.envelope, source, (error) => finish(error));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        };
        smtp.connect((error) => {
          if (finished || aborted) return;
          if (error) return finish(error);
          // SMTP replies can resume before an overdue timer after a process
          // stall. Cancel before Nodemailer parses one and advances DATA.
          if (smtp._socket) {
            smtp._socket.prependListener('data', () => {
              if (Date.now() >= deadline) cancel(new SmtpBudgetExceededError(budgetMs));
            });
          }
          if (settings.user && smtp.allowsAuth) {
            smtp.login({ user: settings.user, pass: settings.password ?? '' }, (loginError) => {
              if (finished || aborted) return;
              if (loginError) finish(loginError);
              else send();
            });
          } else send();
        });
      });
    })();
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          const error = new SmtpBudgetExceededError(budgetMs);
          cancel(error);
          reject(error);
        },
        Math.max(1, deadline - Date.now()),
      );
      timer.unref?.();
    });
    return Promise.race([work, budget])
      .catch((error: unknown) => {
        // No settling outbox write can precede cancellation of the real attempt.
        cancel(error instanceof Error ? error : new Error(String(error)));
        throw classifySendFailure(error, phase);
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
        source?.destroy();
        if (connection?._socket) connection._socket.destroy();
        connection?.close();
        cancelCurrent = null;
      });
  }

  return {
    send(mail, sendOptions): Promise<void> {
      // Queuing spends the same budget; an expired queued attempt opens no socket.
      const deadline = Math.min(Date.now() + budgetMs, sendOptions?.deadline ?? Infinity);
      const result = queue.then(() => attempt(mail, deadline));
      queue = result.catch(() => undefined);
      return result;
    },
    close(): void {
      closed = true;
      cancelCurrent?.(new Error('SMTP transport closed'));
      renderer.close();
    },
  };
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Input for {@link EmailService.enqueue}. */
export interface EnqueueEmail {
  /** Recipient address. */
  to: string;
  /** Intended account for user-directed mail. */
  recipientUserId?: string;
  templateKey: EmailTemplateKey;
  /** Template variables; the common ones are filled in automatically. */
  vars?: TemplateVars;
  /** Reusing a key suppresses the duplicate send (at-most-once). */
  idempotencyKey?: string | null;
  /** Variables whose value is already HTML and must not be escaped. */
  rawHtmlVars?: readonly string[];
}

/** Transactional email operations. */
export interface EmailService {
  /** True when a host is configured, so the worker has somewhere to send. */
  isConfigured(): Promise<boolean>;
  /** Environment defaults with the `app_settings` overrides applied. */
  resolveSettings(): Promise<ResolvedSmtpSettings>;
  /** Render a template without queueing it (used by tests and previews). */
  render(
    templateKey: EmailTemplateKey,
    vars?: TemplateVars,
    rawHtmlVars?: readonly string[],
  ): Promise<RenderedEmail>;
  /** Resolve shared template state once and return a pure per-recipient renderer. */
  prepareRenderer(
    templateKey: EmailTemplateKey,
    rawHtmlVars?: readonly string[],
  ): Promise<(vars?: TemplateVars) => RenderedEmail>;
  /**
   * Render and queue one message. Never throws for a duplicate key. A message
   * rendered from a bearer template (verification, password reset) is stored
   * sealed, so the returned row's content is the envelope, not the text.
   */
  enqueue(input: EnqueueEmail): Promise<{ entry: EmailOutboxRecord; created: boolean }>;
  /**
   * Send a probe message straight through SMTP, bypassing the outbox, so the
   * admin settings page can report a configuration error immediately.
   */
  sendTest(to: string): Promise<{ ok: boolean; error: string | null }>;
  /** The admin override for a key, or the built-in default. */
  resolveTemplate(key: EmailTemplateKey): Promise<EmailTemplateContent>;
}

/** Dependencies of {@link createEmailService}. */
export interface EmailServiceDeps {
  config: NexusConfig;
  store: NexusStore;
  crypto: NexusCrypto;
  /** Structured logger; failures are logged, never thrown at the caller. */
  log?: (obj: Record<string, unknown>, message: string) => void;
  /** Override the transport used by {@link EmailService.sendTest}. */
  transportFactory?: MailTransportFactory;
}

/** Build the email service. */
export function createEmailService(deps: EmailServiceDeps): EmailService {
  const { config, store, crypto } = deps;

  /** The last password-source warning logged, so a misconfiguration is not logged every poll. */
  let lastPasswordWarning: string | null = null;

  /** Log a password-source problem once per distinct condition. Never logs a value. */
  function warnPasswordSource(condition: string, message: string): void {
    if (lastPasswordWarning === condition) return;
    lastPasswordWarning = condition;
    deps.log?.({ setting: SMTP_PASSWORD_SETTINGS_KEY, condition }, message);
  }

  /**
   * The SMTP password to present, decided by where it would come from.
   *
   * `smtp.password` and `NEXUS_SMTP_PASSWORD` are credentials for different
   * relays as soon as the stored connection moves, so the environment's is a
   * fallback only in the one case it was issued for (issue #342):
   *
   * - a stored override that decrypts is used;
   * - a stored override that does **not** decrypt — `NEXUS_SECRET_KEY`
   *   rotated without `rotate-key`, or a corrupted row — fails closed: no
   *   password is sent, and the condition is logged. It used to read as
   *   "absent" and fall through to the environment's password, which then went
   *   to the *stored* host under the *stored* username;
   * - with no override at all, the environment's password is used only while
   *   the effective connection is the environment's own
   *   ({@link smtpConnectionMatchesEnvironment}), the same rule the settings
   *   endpoint applies before it lets an override be cleared.
   */
  async function resolvePassword(stored: StoredSmtpSettings): Promise<string | null> {
    const override = await readEncryptedSettingState(store, crypto, SMTP_PASSWORD_SETTINGS_KEY);
    if (override.state === 'value') {
      lastPasswordWarning = null;
      return override.value;
    }
    if (override.state === 'unreadable') {
      warnPasswordSource(
        'unreadable',
        'The stored SMTP password cannot be decrypted with the current NEXUS_SECRET_KEY; ' +
          'sending no SMTP password until an administrator re-enters it (see the key ' +
          'rotation runbook)',
      );
      return null;
    }
    if (config.smtp.password === undefined) {
      lastPasswordWarning = null;
      return null;
    }
    if (!smtpConnectionMatchesEnvironment(stored, config)) {
      warnPasswordSource(
        'environment-mismatch',
        'NEXUS_SMTP_PASSWORD belongs to the environment SMTP connection, and the stored ' +
          'connection differs from it; sending no SMTP password until an administrator ' +
          'stores one for the configured relay',
      );
      return null;
    }
    lastPasswordWarning = null;
    return config.smtp.password;
  }

  async function resolveSettings(): Promise<ResolvedSmtpSettings> {
    const stored = await readStoredSmtp(store);
    return {
      host: stored.host ?? config.smtp.host ?? null,
      port: stored.port ?? config.smtp.port,
      secure: stored.secure ?? config.smtp.secure,
      user: stored.username ?? config.smtp.user ?? null,
      password: await resolvePassword(stored),
      from: stored.from_address ?? config.smtp.from,
    };
  }

  async function resolveTemplate(key: EmailTemplateKey): Promise<EmailTemplateContent> {
    const override = await store.emailTemplates.get(key);
    if (override) {
      return {
        subject: override.subject,
        body_html: override.body_html,
        body_text: override.body_text,
      };
    }
    return DEFAULT_EMAIL_TEMPLATES[key];
  }

  /** Variables every template gets for free. */
  async function commonVars(): Promise<TemplateVars> {
    const branding = await readBranding(store);
    return {
      portal_name: branding.portal_name,
      portal_url: config.publicUrl,
      year: new Date().getUTCFullYear(),
    };
  }

  /**
   * The template `render` actually uses: the stored override when it satisfies
   * the link policy, otherwise the built-in template.
   *
   * An override saved before the policy existed can name a destination the
   * policy now refuses. Refusing to send at all would turn one stale template
   * into an account-recovery outage (no verification or reset mail), so the
   * built-in template — which the policy always accepts — is sent instead and
   * the refusal is logged for the operator. Saves are still rejected outright
   * by `updateEmailTemplate`, so this fallback only ever covers legacy rows.
   */
  async function usableTemplate(key: EmailTemplateKey): Promise<EmailTemplateContent> {
    const override = await store.emailTemplates.get(key);
    if (!override) return DEFAULT_EMAIL_TEMPLATES[key];
    const content = {
      subject: override.subject,
      body_html: override.body_html,
      body_text: override.body_text,
    };
    try {
      validateTemplateLinks(content, config);
      return content;
    } catch (error) {
      deps.log?.(
        { template: key, error: error instanceof Error ? error.message : 'validation failed' },
        'Stored email template refused by the link policy; sending the built-in template',
      );
      return DEFAULT_EMAIL_TEMPLATES[key];
    }
  }

  async function render(
    templateKey: EmailTemplateKey,
    vars: TemplateVars = {},
    rawHtmlVars: readonly string[] = [],
  ): Promise<RenderedEmail> {
    const renderer = await prepareRenderer(templateKey, rawHtmlVars);
    return renderer(vars);
  }

  async function prepareRenderer(
    templateKey: EmailTemplateKey,
    rawHtmlVars: readonly string[] = [],
  ): Promise<(vars?: TemplateVars) => RenderedEmail> {
    const content = await usableTemplate(templateKey);
    const common = await commonVars();
    return (vars: TemplateVars = {}) => {
      try {
        const merged = { ...common, ...vars };
        const rendered = renderTemplate(content, merged, { rawHtmlVars });
        // Recheck substituted destinations, including raw HTML from the composer.
        // Plain-text values are escaped text, not destinations, so they are
        // judged as an inert stand-in: rechecking them for real read a display
        // name like `Big Data: Ops` as a `data:` URL and dropped the mail (#324).
        // Template validation already confines them to text, since only a
        // `*_url` placeholder may fill a link or attribute.
        const standIn: TemplateVars = {};
        for (const [name, value] of Object.entries(merged)) {
          const inert =
            value !== undefined &&
            value !== null &&
            !isUrlVariable(name) &&
            !rawHtmlVars.includes(name);
          standIn[name] = inert ? 'x' : value;
        }
        // Each raw-HTML value must also stand alone as complete markup. In
        // context it is judged next to stand-ins, so a value ending inside an
        // open tag or attribute (`<a href="`) would pass there and let the
        // plain-text value that follows it become the link.
        for (const name of rawHtmlVars) {
          const value = merged[name];
          if (value === undefined || value === null) continue;
          validateTemplateLinks({ subject: '', body_html: String(value), body_text: '' }, config);
        }
        const checked = renderTemplate(content, standIn, { rawHtmlVars });
        validateTemplateLinks(
          { subject: checked.subject, body_html: checked.html, body_text: checked.text },
          config,
        );
        // An explicit off-portal URL in text is still autolinked by mail clients.
        validateRenderedTextLinks(
          { subject: rendered.subject, body_html: rendered.html, body_text: rendered.text },
          config,
        );
        return rendered;
      } catch (error) {
        deps.log?.(
          {
            template: templateKey,
            error: error instanceof Error ? error.message : 'render failed',
          },
          'Refused unsafe email template',
        );
        throw error;
      }
    };
  }

  async function transportFor(): Promise<MailTransport | null> {
    if (deps.transportFactory) return deps.transportFactory();
    const settings = await resolveSettings();
    if (!settings.host) return null;
    return createSmtpTransport(settings);
  }

  return {
    resolveSettings,
    resolveTemplate,
    render,
    prepareRenderer,

    async isConfigured(): Promise<boolean> {
      const settings = await resolveSettings();
      return settings.host !== null && settings.host !== '';
    },

    async enqueue(input) {
      const rendered = await render(input.templateKey, input.vars, input.rawHtmlVars);
      // A single-use link never reaches the table in plaintext: see
      // `sealed-outbox.ts`. Everything else is stored as rendered.
      if (isBearerTemplate(input.templateKey)) {
        return store.emailOutbox.enqueue(
          sealedEnqueueInput(crypto, {
            to: input.to,
            recipientUserId: input.recipientUserId,
            content: rendered,
            idempotencyKey: input.idempotencyKey ?? null,
          }),
        );
      }
      return store.emailOutbox.enqueue({
        to_email: input.to,
        priority: input.templateKey === 'mass' ? OUTBOX_PRIORITY.low : OUTBOX_PRIORITY.normal,
        recipient_user_id: input.recipientUserId ?? null,
        subject: rendered.subject,
        body_html: rendered.html,
        body_text: rendered.text,
        idempotency_key: input.idempotencyKey ?? null,
      });
    },

    async sendTest(to): Promise<{ ok: boolean; error: string | null }> {
      let transport: MailTransport | null = null;
      try {
        transport = await transportFor();
        if (!transport) {
          return { ok: false, error: 'SMTP is not configured: set a host first' };
        }
        const branding = await readBranding(store);
        await transport.send({
          to,
          subject: `${branding.portal_name} SMTP test`,
          // The portal name is admin-set text, escaped like any template value (#334).
          html:
            `<p>This is a test message from ${escapeHtml(branding.portal_name)}. ` +
            'SMTP is configured correctly.</p>',
          text:
            `This is a test message from ${branding.portal_name}. ` +
            'SMTP is configured correctly.\n',
        });
        return { ok: true, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log?.({ error: message }, 'SMTP test message failed');
        return { ok: false, error: message };
      } finally {
        await transport?.close?.();
      }
    },
  };
}
