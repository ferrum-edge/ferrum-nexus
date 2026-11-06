import type { NexusConfig } from '../config/index.js';
import { validationFailed } from '../lib/errors.js';
import type { EmailTemplateContent } from './templates.js';

export const TEMPLATE_LINK_HOSTS_SETTING = 'NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
/** Destination variables: the only placeholders a link, attribute or CSS url() may hold. */
const URL_VARIABLE = /_url$/;
const ACTION_URL = /\{\{\s*(?:reset_url|verification_url)\s*\}\}/g;
const URL_ATTRIBUTE = /^(?:href|src|action|srcset|data|poster|formaction|background|xlink:href)$/;
const ACTIVE_TAG =
  /^(?:script|style|base|iframe|frame|frameset|object|embed|meta|link|svg|math|textarea|title|xmp|plaintext|noscript|noembed|template)$/;
const CHARACTER_REFERENCE = /&#(x[0-9a-f]+|[0-9]+);?|&([a-z][a-z0-9]*);/gi;
const URL_STRIPPED_CHARACTERS = /[\u0000-\u0020\u007f]/g;
const BACKSLASHES = /\\/g;
const LINE_BREAKS = /[\r\n]/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const SCRIPT_OR_DATA_SCHEME = /\b(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a)\s*:/i;
const SCANNED_URL = /(?:https?\s*:\s*[/\\]{2}|[/\\]{2})[^\s<>"'()]+/gi;
const LINK_ATTRIBUTE =
  /\b(href|src|action|srcset|data|poster|formaction|background|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
const WHITESPACE_RUN = /\s+/;
const AMBIGUOUS_CSS = /\\|\/\*|@|expression\s*\(/i;
const CSS_URL = /url\s*\(([^()]*)\)/gi;
const QUOTED_VALUE = /^(['"])(.*)\1$/s;
const QUOTE = /["']/;
const CSS_URL_OPENING = /url\s*\(/i;
// Sticky scanners: every exec below sets lastIndex first, so one shared instance is safe.
const HTML_TAG = /<\/?([a-z][a-z0-9:-]*)([^<>]*)>/giy;
const HTML_ATTRIBUTE = /\s+([^\s=<>"'`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'`=]+)))?/gy;
const SELF_CLOSING_SLASH = /\/\s*$/;
const DETACHED_SELF_CLOSING = /(?:^|[\s"'])\/\s*$/;
const EVENT_HANDLER_ATTRIBUTE = /^on/i;
const WHITESPACE = /\s/;
const TEXT_URL = /https?:[/\\]{2}[^\s<>"'()]+/gi;

// Decode structural entities and common typography. Unknown named entities are
// refused rather than relying on a mail client's possibly different decoder.
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  quot: '"',
  apos: "'",
  lt: '<',
  gt: '>',
  nbsp: ' ',
  middot: '·',
  hellip: '…',
  copy: '©',
  reg: '®',
  ndash: '–',
  mdash: '—',
  colon: ':',
  sol: '/',
  bsol: '\\',
  equals: '=',
  Tab: '\t',
  NewLine: '\n',
};

/**
 * True when `name` is a destination variable (`portal_url`, `reset_url`, …).
 *
 * Every other variable is plain text — a display name, an API name, a note —
 * and is only ever interpolated as text (#324).
 */
export function isUrlVariable(name: string): boolean {
  return URL_VARIABLE.test(name);
}

/**
 * Decode HTML character references the way {@link validateTemplateLinks} reads
 * a template, refusing anything a mail client might decode differently.
 */
function decodeEntities(value: string, refuse: (construct: string) => never): string {
  return value.replace(
    CHARACTER_REFERENCE,
    (_match: string, code: string | undefined, name: string | undefined) => {
      if (code) {
        const number = code.toLowerCase().startsWith('x')
          ? parseInt(code.slice(1), 16)
          : parseInt(code, 10);
        if (number === 0 || number > 0x10ffff || (number >= 0xd800 && number <= 0xdfff)) {
          refuse('invalid HTML entity');
        }
        return String.fromCodePoint(number);
      }
      if (!name || !Object.hasOwn(ENTITIES, name)) refuse('unsupported HTML entity');
      return ENTITIES[name] ?? refuse('unsupported HTML entity');
    },
  );
}

/** Validate destinations without ever including a URL path or token in errors. */
export function validateTemplateLinks(
  content: EmailTemplateContent,
  config: Pick<NexusConfig, 'publicUrl' | 'emailTemplateAllowedLinkHosts'>,
): void {
  const portal = new URL(config.publicUrl);

  for (const field of ['subject', 'body_html', 'body_text'] as const) {
    function refuse(construct: string): never {
      throw validationFailed(
        `Email template ${field} refuses ${construct}; check ${TEMPLATE_LINK_HOSTS_SETTING}`,
        { field, construct, setting: TEMPLATE_LINK_HOSTS_SETTING },
      );
    }

    function decode(value: string): string {
      return decodeEntities(value, refuse);
    }

    function destination(value: string, construct: string): void {
      const normalized = value.replace(URL_STRIPPED_CHARACTERS, '').replace(BACKSLASHES, '/');
      const variables = [...value.matchAll(PLACEHOLDER)];
      if (variables.length) {
        if (variables.length !== 1 || variables[0]?.[0] !== value.trim()) {
          refuse(`concatenated placeholder in ${construct}`);
        }
        // Only a destination variable may be a destination (#324): the send-time
        // check sees plain-text values as inert stand-ins, so a display name in
        // an href would otherwise go unchecked.
        if (!isUrlVariable(variables[0]?.[1] ?? '')) {
          refuse(`non-URL placeholder in ${construct}`);
        }
        return; // The entire substituted value is checked again before enqueueing.
      }
      let url: URL;
      try {
        url = new URL(normalized, portal);
      } catch {
        refuse(`invalid URL in ${construct}`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        refuse(`unsupported scheme in ${construct}`);
      }
      if (url.username || url.password) refuse(`URL credentials in ${construct}`);
      if (
        url.origin !== portal.origin &&
        !config.emailTemplateAllowedLinkHosts.includes(url.host.toLowerCase())
      ) {
        refuse(`host '${url.host}' in ${construct}`);
      }
    }

    const source = content[field];
    const decoded = decode(source).replace(LINE_BREAKS, ' ').replace(CONTROL_CHARACTERS, '');
    if (SCRIPT_OR_DATA_SCHEME.test(decoded)) {
      refuse('javascript: or data: scheme');
    }
    // Scan all fields, including text and URLs in otherwise unrecognised attributes.
    // A URL parser strips control characters, so they are deleted for the scan;
    // a mail client autolinking text splits at them instead, so the text is also
    // scanned with them as spaces — otherwise a TAB hides a second URL in the
    // first one's path.
    const split = decode(source).replace(CONTROL_CHARACTERS, ' ');
    for (const scanned of [decoded, split]) {
      for (const match of scanned.matchAll(SCANNED_URL)) {
        destination(match[0], 'absolute URL');
      }
    }
    if (field !== 'body_html') {
      for (const match of decoded.matchAll(LINK_ATTRIBUTE)) {
        const key = (match[1] ?? '').toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        if (key === 'srcset' && ![...value.matchAll(PLACEHOLDER)].length) {
          for (const candidate of value.split(',')) {
            destination(candidate.trim().split(WHITESPACE_RUN)[0] ?? '', key);
          }
        } else {
          destination(value, key);
        }
      }
    }

    function css(value: string): void {
      // Escapes/comments can disguise url(), @import and active CSS constructs.
      if (AMBIGUOUS_CSS.test(value)) refuse('ambiguous or active CSS');
      const remaining = value.replace(CSS_URL, (_match: string, raw: string) => {
        const target = raw.trim().replace(QUOTED_VALUE, '$2');
        if (QUOTE.test(target)) refuse('malformed CSS url()');
        if ([...target.matchAll(ACTION_URL)].length) refuse('action URL in CSS url()');
        destination(target, 'CSS url()');
        return '';
      });
      if (CSS_URL_OPENING.test(remaining)) refuse('malformed CSS url()');
    }

    // Consume whole tags and attributes, refusing ambiguous syntax instead of
    // guessing how an HTML parser will repair it. Text is never parsed as markup
    // after entity decoding, so escaped recipient names remain ordinary text.
    let text = '';
    let offset = 0;
    while (field === 'body_html' && offset < source.length) {
      const start = source.indexOf('<', offset);
      if (start === -1) break;
      text += source.slice(offset, start);
      HTML_TAG.lastIndex = start;
      const match = HTML_TAG.exec(source);
      if (!match) refuse('malformed or unsupported HTML');
      const name = (match[1] ?? '').toLowerCase();
      if (ACTIVE_TAG.test(name)) refuse(`active HTML tag '${name}'`);
      let attributes = match[2] ?? '';
      if (SELF_CLOSING_SLASH.test(attributes)) {
        if (!DETACHED_SELF_CLOSING.test(attributes)) refuse('ambiguous self-closing HTML tag');
        attributes = attributes.replace(SELF_CLOSING_SLASH, '');
      }
      let position = 0;
      const seen = new Set<string>();
      const attributesEnd = attributes.trimEnd().length;
      while (position < attributesEnd) {
        HTML_ATTRIBUTE.lastIndex = position;
        const attr = HTML_ATTRIBUTE.exec(attributes);
        if (!attr) refuse('malformed HTML attribute');
        position = HTML_ATTRIBUTE.lastIndex;
        const key = decode(attr[1] ?? '').toLowerCase();
        const value = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
        if ([...key.matchAll(PLACEHOLDER)].length) refuse('placeholder in HTML attribute name');
        if (seen.has(key)) refuse('duplicate HTML attribute');
        seen.add(key);
        if (EVENT_HANDLER_ATTRIBUTE.test(key) || key === 'srcdoc') refuse('active HTML attribute');
        const actions = [...value.matchAll(ACTION_URL)];
        if (actions.length && (name !== 'a' || key !== 'href' || actions[0]?.[0] !== value)) {
          refuse(`action URL must be the entire anchor href, not ${key}`);
        }
        const variables = [...value.matchAll(PLACEHOLDER)];
        if (variables.length && (variables.length !== 1 || variables[0]?.[0] !== value.trim())) {
          refuse(`concatenated placeholder in ${key}`);
        }
        if (key === 'style') css(value);
        if (URL_ATTRIBUTE.test(key) || variables.length) {
          if (key === 'srcset') {
            for (const candidate of value.split(',')) {
              destination(candidate.trim().split(WHITESPACE_RUN)[0] ?? '', key);
            }
          } else {
            destination(value, key);
          }
        }
      }
      offset = HTML_TAG.lastIndex;
      text += ' '; // Keep separate text nodes separate for placeholder checks.
    }
    text += source.slice(offset);
    const decodedText = decode(text);
    for (const match of decodedText.matchAll(ACTION_URL)) {
      if (field !== 'body_text') refuse('action URL outside an anchor href or text body');
      const before = decodedText[match.index - 1];
      const after = decodedText[match.index + match[0].length];
      if ((before && !WHITESPACE.test(before)) || (after && !WHITESPACE.test(after))) {
        refuse('concatenated action URL in text');
      }
    }
    if (CSS_URL_OPENING.test(decodedText)) css(decodedText);
  }
}

/**
 * Refuse an absolute `http(s)://` URL in a real rendering that points off the
 * portal origin and the link allowlist (#324).
 *
 * The send-time {@link validateTemplateLinks} pass judges a rendering in which
 * every plain-text variable is an inert stand-in, because escaped text such as
 * `Big Data: Ops` or `Bob//Team` is not a destination. Mail clients do,
 * however, autolink an explicit URL in text, so this pass reads the message the
 * recipient actually gets — covering a URL inside a value as well as one a
 * value completes next to template text. Only explicit `http:`/`https:` URLs
 * count: a word followed by a colon, or a bare `//`, is ordinary text.
 */
export function validateRenderedTextLinks(
  rendered: EmailTemplateContent,
  config: Pick<NexusConfig, 'publicUrl' | 'emailTemplateAllowedLinkHosts'>,
): void {
  const portal = new URL(config.publicUrl);

  for (const field of ['subject', 'body_html', 'body_text'] as const) {
    function refuse(construct: string): never {
      throw validationFailed(
        `Email ${field} refuses ${construct}; check ${TEMPLATE_LINK_HOSTS_SETTING}`,
        { field, construct, setting: TEMPLATE_LINK_HOSTS_SETTING },
      );
    }

    // The subject and text body are shown verbatim; only HTML decodes references.
    const source =
      field === 'body_html' ? decodeEntities(rendered[field], refuse) : rendered[field];
    // A mail client splits text at a control character (TAB, VT, FF, …) rather
    // than joining around it, so each side is judged as its own URL.
    const text = source.replace(CONTROL_CHARACTERS, ' ');
    for (const match of text.matchAll(TEXT_URL)) {
      let url: URL;
      try {
        url = new URL(match[0].replace(BACKSLASHES, '/'));
      } catch {
        refuse('invalid URL in text');
      }
      if (url.username || url.password) refuse('URL credentials in text');
      if (
        url.origin !== portal.origin &&
        !config.emailTemplateAllowedLinkHosts.includes(url.host.toLowerCase())
      ) {
        refuse(`host '${url.host}' in text`);
      }
    }
  }
}
