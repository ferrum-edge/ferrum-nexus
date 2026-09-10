/**
 * Transactional email: template resolution, SMTP settings and the outbox.
 *
 * **Nothing in Nexus sends mail inline.** Every message is rendered here and
 * inserted into `email_outbox`; the {@link ../email/outbox-worker.js outbox
 * worker} drains the queue out of band. That keeps a slow or broken SMTP server
 * from turning an approval into a 502, and gives retries a home.
 *
 * SMTP configuration is layered: the environment (`NEXUS_SMTP_*`) supplies the
 * deployment default and the `smtp` / `smtp.password` `app_settings` rows
 * override it at runtime, so an admin can point the portal at a different relay
 * without a redeploy. The password is AES-256-GCM encrypted at rest and is
 * never returned by any endpoint.
 *
 * `enqueue` is at-most-once when given an `idempotencyKey`: a second call with
 * the same key returns the existing row and inserts nothing.
 */

import type { Readable } from 'node:stream';

import nodemailer from 'nodemailer';

import type { EmailTemplateKey } from '@ferrum-nexus/shared';

import {
  readBranding,
  readEncryptedSetting,
  readStoredSmtp,
  SMTP_PASSWORD_SETTINGS_KEY,
} from '../admin/settings-service.js';
import type { NexusConfig } from '../config/index.js';
import type { EmailOutboxRecord, NexusStore } from '../db/store.js';
import type { NexusCrypto } from '../lib/crypto.js';
import {
  DEFAULT_EMAIL_TEMPLATES,
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
  send(mail: OutboundMail): Promise<void>;
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
 * This is a deadline, not an estimate: {@link createSmtpTransport} races every
 * `send` against it, so a claim's lifetime is bounded whatever the relay does.
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
 * - `unknown` — the message was never compiled, or nodemailer's shape changed
 *   and the hook below never ran;
 * - `before-data` — compiled, but the body was never streamed: the relay cannot
 *   have the message;
 * - `data-in-flight` — the body was partly written. SMTP only accepts a message
 *   at the end-of-data marker, so this is still "not delivered";
 * - `data-sent` — the whole body reached the socket. Whether the relay queued
 *   it is now unknowable without an acknowledgement.
 */
type SendPhase = 'unknown' | 'before-data' | 'data-in-flight' | 'data-sent';

/** Mutable per-attempt state the message-source hook writes to. */
interface SendState {
  phase: SendPhase;
}

/** The compiled MIME node, as far as this module needs it. */
interface CompiledMessage {
  createReadStream?: (...args: unknown[]) => Readable;
}

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
      `${reason}; the relay already had the whole message`,
      { cause: error },
    );
  }
  if (phase === 'unknown' && error instanceof SmtpBudgetExceededError) {
    // The budget fired and nothing told us how far the message got. Parking is
    // the safe side of that coin: a duplicate password reset is worse than a
    // row an operator has to look at.
    return new MailDeliveredUnacknowledgedError(
      `${reason}; how far the message got could not be determined`,
      { cause: error },
    );
  }
  return error;
}

/** Build a nodemailer-backed transport for resolved settings. */
export function createSmtpTransport(
  settings: ResolvedSmtpSettings,
  options: SmtpTransportOptions = {},
): MailTransport {
  const budgetMs = options.budgetMs ?? SMTP_SEND_BUDGET_MS;
  const transporter = nodemailer.createTransport({
    host: settings.host ?? '',
    port: settings.port,
    secure: settings.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
  });

  /** The attempt currently in flight, or `null` between attempts. */
  let current: SendState | null = null;

  // Nodemailer streams the compiled message into the `DATA` command, so the
  // moment that source stream is fully consumed is the moment the relay has
  // seen the end of the message. Wrapping it through the documented `stream`
  // plugin step is what turns "the attempt timed out" into an answerable
  // question; it changes nothing about the message itself, and if the hook ever
  // stops firing the phase simply stays `unknown`.
  transporter.use('stream', (mail, done) => {
    const state = current;
    const message = (mail as unknown as { message?: CompiledMessage }).message;
    const createReadStream = message?.createReadStream;
    if (state && message && typeof createReadStream === 'function') {
      const create = createReadStream.bind(message);
      state.phase = 'before-data';
      message.createReadStream = (...args: unknown[]): Readable => {
        state.phase = 'data-in-flight';
        const stream = create(...args);
        stream.once('end', () => {
          state.phase = 'data-sent';
        });
        return stream;
      };
    }
    done();
  });

  // One attempt at a time, so `current` is never ambiguous. The worker delivers
  // its claims one at a time anyway; this only guards a caller that does not.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    async send(mail) {
      await serialize(async () => {
        const state: SendState = { phase: 'unknown' };
        current = state;
        let timer: NodeJS.Timeout | undefined;
        const attempt = transporter
          .sendMail({
            from: settings.from,
            to: mail.to,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
          })
          .then((): void => undefined);
        try {
          // The race is what makes the budget a bound rather than a comment:
          // nodemailer's three timeouts are per-phase, so a conforming relay
          // that answers slowly can otherwise outlive the stale threshold and
          // have its claim reclaimed mid-flight.
          await new Promise<void>((resolve, reject) => {
            timer = setTimeout(() => reject(new SmtpBudgetExceededError(budgetMs)), budgetMs);
            timer.unref?.();
            // Attaching both handlers here is also what keeps an abandoned
            // attempt from surfacing as an unhandled rejection.
            attempt.then(resolve, reject);
          });
        } catch (error) {
          if (error instanceof SmtpBudgetExceededError) {
            // Nodemailer has no per-send abort. `close()` is the only lever, and
            // a connection it cannot reach is left to the socket-inactivity
            // timeout — the claim, which is what mattered, is already released.
            try {
              transporter.close();
            } catch {
              // Closing must never mask the delivery outcome.
            }
          }
          throw classifySendFailure(error, state.phase);
        } finally {
          if (timer) clearTimeout(timer);
          current = null;
        }
      });
    },
    close() {
      transporter.close();
    },
  };
}

/* ── Service ────────────────────────────────────────────────────────────── */

/** Input for {@link EmailService.enqueue}. */
export interface EnqueueEmail {
  /** Recipient address. */
  to: string;
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
  /** Render and queue one message. Never throws for a duplicate key. */
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

  async function resolveSettings(): Promise<ResolvedSmtpSettings> {
    const stored = await readStoredSmtp(store);
    const password =
      (await readEncryptedSetting(store, crypto, SMTP_PASSWORD_SETTINGS_KEY)) ??
      config.smtp.password ??
      null;
    return {
      host: stored.host ?? config.smtp.host ?? null,
      port: stored.port ?? config.smtp.port,
      secure: stored.secure ?? config.smtp.secure,
      user: stored.username ?? config.smtp.user ?? null,
      password,
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
    const content = await resolveTemplate(templateKey);
    const common = await commonVars();
    return (vars: TemplateVars = {}) =>
      renderTemplate(content, { ...common, ...vars }, { rawHtmlVars });
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
      return store.emailOutbox.enqueue({
        to_email: input.to,
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
          html:
            `<p>This is a test message from ${branding.portal_name}. ` +
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
