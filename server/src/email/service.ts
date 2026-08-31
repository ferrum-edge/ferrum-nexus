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
 */
export interface MailTransport {
  send(mail: OutboundMail): Promise<void>;
  close?(): Promise<void> | void;
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

/** Build a nodemailer-backed transport for resolved settings. */
export function createSmtpTransport(settings: ResolvedSmtpSettings): MailTransport {
  const transporter = nodemailer.createTransport({
    host: settings.host ?? '',
    port: settings.port,
    secure: settings.secure,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? '' } } : {}),
  });
  return {
    async send(mail) {
      await transporter.sendMail({
        from: settings.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
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
    const content = await resolveTemplate(templateKey);
    const merged = { ...(await commonVars()), ...vars };
    return renderTemplate(content, merged, { rawHtmlVars });
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
