/**
 * Email helpers: template rendering and SMTP transport setup.
 *
 * Templates use a minimal `{{var}}` substitution. If no SMTP host is
 * configured the transport simulates delivery in non-production without
 * logging body content; production treats missing SMTP as a delivery error.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { ResolvedConfig } from '../config/index.js';

export interface RenderedEmail {
  subject: string;
  body: string;
}

const PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(PATTERN, (_, key: string) => {
    const segments = key.split('.');
    let value: unknown = vars;
    for (const segment of segments) {
      if (value && typeof value === 'object' && segment in (value as Record<string, unknown>)) {
        value = (value as Record<string, unknown>)[segment];
      } else {
        value = undefined;
        break;
      }
    }
    return value == null ? '' : String(value);
  });
}

export function renderEmail(
  template: { subject_template: string; body_template: string },
  vars: Record<string, unknown>,
): RenderedEmail {
  return {
    subject: renderTemplate(template.subject_template, vars),
    body: renderTemplate(template.body_template, vars),
  };
}

// Reject anything that looks like multiple recipients or SMTP header
// smuggling. nodemailer accepts CSV lists in `to` by default, so a stray
// comma from a caller would silently broadcast.
function assertSingleAddress(to: string): void {
  if (!to || /[\r\n,;]/.test(to)) {
    throw new Error(`Invalid email recipient: ${JSON.stringify(to)}`);
  }
}

export interface MailerSendOpts {
  to: string;
  subject: string;
  body: string;
  /** Extra SMTP headers (e.g. List-Unsubscribe). */
  headers?: Record<string, string>;
}

export function createMailer(
  config: ResolvedConfig,
  logger: Logger,
): { send: (opts: MailerSendOpts) => Promise<void> } {
  if (!config.email.smtpHost) {
    logger.warn('SMTP not configured');
    return {
      async send({ to, subject }) {
        assertSingleAddress(to);
        if (config.nodeEnv === 'production') {
          throw new Error('SMTP is not configured');
        }
        logger.info({ to, subject }, 'simulated email send');
      },
    };
  }

  const transport: Transporter = nodemailer.createTransport({
    host: config.email.smtpHost,
    port: config.email.smtpPort,
    secure: config.email.smtpSecure,
    auth:
      config.email.smtpUsername && config.email.smtpPassword
        ? { user: config.email.smtpUsername, pass: config.email.smtpPassword }
        : undefined,
  });

  return {
    async send({ to, subject, body, headers }) {
      assertSingleAddress(to);
      await transport.sendMail({
        from: config.email.from,
        to,
        subject,
        text: body,
        headers,
      });
    },
  };
}

export const DEFAULT_TEMPLATES: Record<string, { subject: string; body: string }> = {
  registration_confirmed: {
    subject: 'Confirm your Ferrum Nexus account',
    body:
      'Hi {{name}},\n\nClick the link below to confirm your email and activate your account:\n\n' +
      '{{verifyUrl}}\n\nThis link expires in 24 hours.',
  },
  admin_registration_pending: {
    subject: 'New Ferrum Nexus registration pending approval',
    body:
      '{{userName}} ({{userEmail}}) registered for Ferrum Nexus and is awaiting administrator approval.\n\n' +
      'Review at: {{reviewUrl}}',
  },
  registration_pending_admin_approval: {
    subject: 'Your Ferrum Nexus registration is pending approval',
    body:
      'Hi {{name}},\n\nYour {{productName}} registration was received and is awaiting administrator approval.',
  },
  registration_denied: {
    subject: 'Ferrum Nexus registration denied',
    body: 'Hi {{name}},\n\nYour registration was denied.\n\nReason: {{reason}}',
  },
  password_reset: {
    subject: 'Reset your Ferrum Nexus password',
    body:
      'Hi {{name}},\n\nUse the link below to reset your password. It expires in 1 hour.\n\n{{resetUrl}}',
  },
  access_request_created: {
    subject: 'New access request for {{apiTitle}}',
    body:
      'A new access request was submitted for "{{apiTitle}}" by {{clientName}} ({{clientEmail}}).\n\n' +
      'Justification:\n{{justification}}\n\nReview at: {{reviewUrl}}',
  },
  access_request_approved: {
    subject: 'Access approved for {{apiTitle}}',
    body:
      'Your access request for "{{apiTitle}}" was approved.\n\n' +
      'Provider note: {{providerReason}}\n\nManage your access: {{accessUrl}}',
  },
  access_request_denied: {
    subject: 'Access denied for {{apiTitle}}',
    body:
      'Your access request for "{{apiTitle}}" was denied.\n\nProvider note: {{providerReason}}',
  },
  access_revoked: {
    subject: 'Access revoked for {{apiTitle}}',
    body:
      'Your access to "{{apiTitle}}" has been revoked.\n\nReason: {{reason}}',
  },
  credential_created: {
    subject: 'New credential created',
    body:
      'A new {{credentialType}} credential ("{{label}}") was created on your Ferrum Nexus account.',
  },
  credential_rotation_completed: {
    subject: 'Credential rotation completed',
    body:
      'Your {{credentialType}} credential ("{{label}}") was rotated successfully.',
  },
  message_received: {
    subject: 'New message from {{senderName}}',
    body: '{{senderName}} sent you a message regarding {{subject}}:\n\n{{preview}}',
  },
  admin_broadcast: {
    subject: '{{subject}}',
    body: '{{body}}',
  },
  policy_exception_created: {
    subject: 'New API governance exception request',
    body: '{{providerEmail}} requested an API governance exception.\n\nReview at: {{reviewUrl}}',
  },
  policy_exception_approved: {
    subject: 'API governance exception approved',
    body: 'Your API governance exception was approved.\n\nReviewer notes: {{reviewerNotes}}',
  },
  policy_exception_denied: {
    subject: 'API governance exception denied',
    body: 'Your API governance exception was denied.\n\nReviewer notes: {{reviewerNotes}}',
  },
};
