/**
 * Built-in transactional email templates plus the `{{placeholder}}` renderer.
 *
 * Every {@link EmailTemplateKey} has a default here. Admins may override any of
 * them from `PUT /api/admin/email-templates/:key`; the email service resolves
 * **DB override first, built-in default second** and never mixes the two.
 *
 * Rendering rules:
 *
 * - Placeholders are `{{snake_case}}`; an unknown or absent placeholder renders
 *   as the empty string so a half-filled template still sends.
 * - Values interpolated into `body_html` are **HTML-escaped**, so a display
 *   name of `<script>` can never become markup. The subject and `body_text` are
 *   plain text and are interpolated verbatim.
 * - A caller that deliberately supplies HTML (the mass-email composer) names
 *   those variables in `rawHtmlVars`; only those skip escaping.
 */

import type { EmailTemplateKey } from '@ferrum-nexus/shared';

/** The three renderable parts of a template, as stored in `email_templates`. */
export interface EmailTemplateContent {
  subject: string;
  body_html: string;
  body_text: string;
}

/** A rendered message, ready for the outbox. */
export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Values substituted into a template. `null`/`undefined` render as empty. */
export type TemplateVars = Record<string, string | number | boolean | null | undefined>;

/** Options accepted by {@link renderTemplate}. */
export interface RenderOptions {
  /** Variables whose value is already HTML and must not be escaped. */
  rawHtmlVars?: readonly string[];
}

/** Placeholders every template may use, whatever its key. */
export const COMMON_TEMPLATE_VARIABLES = [
  'portal_name',
  'portal_url',
  'recipient_name',
  'recipient_email',
  'year',
] as const satisfies readonly string[];

/** Escape a value for interpolation into an HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Substitute `{{name}}` placeholders in `template`.
 *
 * `escape` decides whether values are HTML-escaped; `rawNames` exempts
 * individual variables from escaping (used for admin-authored HTML).
 */
export function interpolate(
  template: string,
  vars: TemplateVars,
  escape: boolean,
  rawNames: readonly string[] = [],
): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined || value === null) return '';
    const text = String(value);
    if (!escape || rawNames.includes(name)) return text;
    return escapeHtml(text);
  });
}

/** Render a template's three parts with one set of variables. */
export function renderTemplate(
  content: EmailTemplateContent,
  vars: TemplateVars,
  options: RenderOptions = {},
): RenderedEmail {
  const raw = options.rawHtmlVars ?? [];
  return {
    // Subject and text body are plain text: escaping them would leak `&amp;`
    // into what the recipient reads.
    subject: interpolate(content.subject, vars, false),
    html: interpolate(content.body_html, vars, true, raw),
    text: interpolate(content.body_text, vars, false),
  };
}

/* ── Built-in defaults ──────────────────────────────────────────────────── */

/** Shared HTML shell so every default template looks like one product. */
function htmlDocument(body: string): string {
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;',
    'font-size:15px;line-height:1.6;color:#1f2937">',
    body,
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />',
    '<p style="font-size:12px;color:#6b7280">',
    '{{portal_name}} &middot; {{portal_url}}',
    '</p>',
    '</div>',
  ].join('');
}

/**
 * The template used for a key when no admin override exists.
 *
 * Keep the placeholder sets in sync with {@link TEMPLATE_VARIABLES} — the admin
 * UI shows that list next to the editor.
 */
export const DEFAULT_EMAIL_TEMPLATES: Readonly<Record<EmailTemplateKey, EmailTemplateContent>> = {
  verification: {
    subject: 'Verify your {{portal_name}} email address',
    body_html: htmlDocument(
      '<p>Hello {{recipient_name}},</p>' +
        '<p>Confirm your email address to finish setting up your {{portal_name}} account.</p>' +
        '<p><a href="{{verification_url}}">Verify my email address</a></p>' +
        '<p>If the link does not work, paste this address into your browser:<br />' +
        '{{verification_url}}</p>' +
        '<p>This link expires in 24 hours. If you did not create an account, ignore this email.</p>',
    ),
    body_text:
      'Hello {{recipient_name}},\n\n' +
      'Confirm your email address to finish setting up your {{portal_name}} account:\n\n' +
      '{{verification_url}}\n\n' +
      'This link expires in 24 hours. If you did not create an account, ignore this email.\n',
  },

  access_approved: {
    subject: 'Access approved: {{api_name}}',
    body_html: htmlDocument(
      '<p>Hello {{recipient_name}},</p>' +
        '<p>Your request for access to <strong>{{api_name}}</strong> was approved by ' +
        '{{decided_by_name}}.</p>' +
        '<p>{{decision_note}}</p>' +
        '<p><a href="{{api_url}}">Open the API in the catalog</a></p>',
    ),
    body_text:
      'Hello {{recipient_name}},\n\n' +
      'Your request for access to {{api_name}} was approved by {{decided_by_name}}.\n\n' +
      '{{decision_note}}\n\n' +
      '{{api_url}}\n',
  },

  access_denied: {
    subject: 'Access request declined: {{api_name}}',
    body_html: htmlDocument(
      '<p>Hello {{recipient_name}},</p>' +
        '<p>Your request for access to <strong>{{api_name}}</strong> was declined by ' +
        '{{decided_by_name}}.</p>' +
        '<p>{{decision_note}}</p>' +
        '<p>You can reply to the provider from the portal if you need more context.</p>',
    ),
    body_text:
      'Hello {{recipient_name}},\n\n' +
      'Your request for access to {{api_name}} was declined by {{decided_by_name}}.\n\n' +
      '{{decision_note}}\n',
  },

  access_revoked: {
    subject: 'Access revoked: {{api_name}}',
    body_html: htmlDocument(
      '<p>Hello {{recipient_name}},</p>' +
        '<p>Your access to <strong>{{api_name}}</strong> has been revoked by ' +
        '{{revoked_by_name}}. Calls made with your gateway credentials will now be ' +
        'rejected for this API.</p>' +
        '<p>{{reason}}</p>',
    ),
    body_text:
      'Hello {{recipient_name}},\n\n' +
      'Your access to {{api_name}} has been revoked by {{revoked_by_name}}.\n' +
      'Calls made with your gateway credentials will now be rejected for this API.\n\n' +
      '{{reason}}\n',
  },

  message_received: {
    subject: 'New message from {{sender_name}}: {{thread_subject}}',
    body_html: htmlDocument(
      '<p>Hello {{recipient_name}},</p>' +
        '<p>{{sender_name}} sent you a message about ' +
        '<strong>{{thread_subject}}</strong>.</p>' +
        '<blockquote style="margin:16px 0;padding:8px 16px;border-left:3px solid #d1d5db">' +
        '{{message_preview}}</blockquote>' +
        '<p><a href="{{thread_url}}">Read and reply in {{portal_name}}</a></p>',
    ),
    body_text:
      'Hello {{recipient_name}},\n\n' +
      '{{sender_name}} sent you a message about {{thread_subject}}.\n\n' +
      '{{message_preview}}\n\n' +
      'Read and reply: {{thread_url}}\n',
  },

  mass: {
    // The admin authors the body; the template only frames it.
    subject: '{{subject}}',
    body_html: htmlDocument('{{body_html}}'),
    body_text: '{{body_text}}\n\n-- \n{{portal_name}} · {{portal_url}}\n',
  },

  credential_rotated: {
    subject: 'A gateway credential was rotated',
    body_html: htmlDocument(
      '<p>Hello {{recipient_name}},</p>' +
        '<p>The credential <strong>{{credential_label}}</strong> ' +
        '(&hellip;{{credential_last4}}) was rotated. The previous secret keeps working ' +
        'until the rotation is finalized.</p>' +
        '<p><a href="{{credentials_url}}">Review your credentials</a></p>' +
        '<p>If this was not you, contact an administrator immediately.</p>',
    ),
    body_text:
      'Hello {{recipient_name}},\n\n' +
      'The credential {{credential_label}} (...{{credential_last4}}) was rotated.\n' +
      'The previous secret keeps working until the rotation is finalized.\n\n' +
      '{{credentials_url}}\n\n' +
      'If this was not you, contact an administrator immediately.\n',
  },
};

/**
 * Placeholders each template may use, surfaced to the admin template editor as
 * `available_variables`. Always includes {@link COMMON_TEMPLATE_VARIABLES}.
 */
export const TEMPLATE_VARIABLES: Readonly<Record<EmailTemplateKey, readonly string[]>> = {
  verification: [...COMMON_TEMPLATE_VARIABLES, 'verification_url', 'verification_token'],
  access_approved: [
    ...COMMON_TEMPLATE_VARIABLES,
    'api_name',
    'api_slug',
    'api_url',
    'decided_by_name',
    'decision_note',
  ],
  access_denied: [
    ...COMMON_TEMPLATE_VARIABLES,
    'api_name',
    'api_slug',
    'decided_by_name',
    'decision_note',
  ],
  access_revoked: [
    ...COMMON_TEMPLATE_VARIABLES,
    'api_name',
    'api_slug',
    'revoked_by_name',
    'reason',
  ],
  message_received: [
    ...COMMON_TEMPLATE_VARIABLES,
    'sender_name',
    'thread_subject',
    'message_preview',
    'thread_url',
  ],
  mass: [...COMMON_TEMPLATE_VARIABLES, 'subject', 'body_html', 'body_text'],
  credential_rotated: [
    ...COMMON_TEMPLATE_VARIABLES,
    'credential_label',
    'credential_last4',
    'credentials_url',
  ],
};

/** Variables of the `mass` template that carry admin-authored HTML. */
export const MASS_RAW_HTML_VARS = ['body_html'] as const;
