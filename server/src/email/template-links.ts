import type { NexusConfig } from '../config/index.js';
import { validationFailed } from '../lib/errors.js';
import type { EmailTemplateContent } from './templates.js';

export const TEMPLATE_LINK_HOSTS_SETTING = 'NEXUS_EMAIL_TEMPLATE_ALLOWED_LINK_HOSTS';

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const ACTION_URL = /\{\{\s*(?:reset_url|verification_url)\s*\}\}/g;
const URL_ATTRIBUTE = /^(?:href|src|action|srcset|data|poster|formaction|background|xlink:href)$/;
const ACTIVE_TAG =
  /^(?:script|style|base|iframe|frame|frameset|object|embed|meta|link|svg|math|textarea|title|xmp|plaintext|noscript|noembed|template)$/;

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
      return value.replace(
        /&#(x[0-9a-f]+|[0-9]+);?|&([a-z][a-z0-9]*);/gi,
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

    function destination(value: string, construct: string): void {
      const normalized = value.replace(/[\u0000-\u0020\u007f]/g, '').replace(/\\/g, '/');
      const variables = [...value.matchAll(PLACEHOLDER)];
      if (variables.length) {
        if (variables.length !== 1 || variables[0]?.[0] !== value.trim()) {
          refuse(`concatenated placeholder in ${construct}`);
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
    const decoded = decode(source)
      .replace(/[\r\n]/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, '');
    if (/\b(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a)\s*:/i.test(decoded)) {
      refuse('javascript: or data: scheme');
    }
    // Scan all fields, including text and URLs in otherwise unrecognised attributes.
    for (const match of decoded.matchAll(/(?:https?\s*:\s*[/\\]{2}|[/\\]{2})[^\s<>"'()]+/gi)) {
      destination(match[0], 'absolute URL');
    }
    if (field !== 'body_html') {
      const links =
        /\b(href|src|action|srcset|data|poster|formaction|background|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/gi;
      for (const match of decoded.matchAll(links)) {
        const key = (match[1] ?? '').toLowerCase();
        const value = match[2] ?? match[3] ?? match[4] ?? '';
        if (key === 'srcset' && ![...value.matchAll(PLACEHOLDER)].length) {
          for (const candidate of value.split(',')) {
            destination(candidate.trim().split(/\s+/)[0] ?? '', key);
          }
        } else {
          destination(value, key);
        }
      }
    }

    function css(value: string): void {
      // Escapes/comments can disguise url(), @import and active CSS constructs.
      if (/\\|\/\*|@|expression\s*\(/i.test(value)) refuse('ambiguous or active CSS');
      const remaining = value.replace(/url\s*\(([^()]*)\)/gi, (_match: string, raw: string) => {
        const target = raw.trim().replace(/^(['"])(.*)\1$/s, '$2');
        if (/["']/.test(target)) refuse('malformed CSS url()');
        if ([...target.matchAll(ACTION_URL)].length) refuse('action URL in CSS url()');
        destination(target, 'CSS url()');
        return '';
      });
      if (/url\s*\(/i.test(remaining)) refuse('malformed CSS url()');
    }

    // Consume whole tags and attributes, refusing ambiguous syntax instead of
    // guessing how an HTML parser will repair it. Text is never parsed as markup
    // after entity decoding, so escaped recipient names remain ordinary text.
    let text = '';
    let offset = 0;
    const tag = /<\/?([a-z][a-z0-9:-]*)([^<>]*)>/giy;
    const attribute = /\s+([^\s=<>"'`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'`=]+)))?/gy;
    while (field === 'body_html' && offset < source.length) {
      const start = source.indexOf('<', offset);
      if (start === -1) break;
      text += source.slice(offset, start);
      tag.lastIndex = start;
      const match = tag.exec(source);
      if (!match) refuse('malformed or unsupported HTML');
      const name = (match[1] ?? '').toLowerCase();
      if (ACTIVE_TAG.test(name)) refuse(`active HTML tag '${name}'`);
      let attributes = match[2] ?? '';
      if (/\/\s*$/.test(attributes)) {
        if (!/(?:^|[\s"'])\/\s*$/.test(attributes)) refuse('ambiguous self-closing HTML tag');
        attributes = attributes.replace(/\/\s*$/, '');
      }
      let position = 0;
      const seen = new Set<string>();
      const attributesEnd = attributes.trimEnd().length;
      while (position < attributesEnd) {
        attribute.lastIndex = position;
        const attr = attribute.exec(attributes);
        if (!attr) refuse('malformed HTML attribute');
        position = attribute.lastIndex;
        const key = decode(attr[1] ?? '').toLowerCase();
        const value = decode(attr[2] ?? attr[3] ?? attr[4] ?? '');
        if ([...key.matchAll(PLACEHOLDER)].length) refuse('placeholder in HTML attribute name');
        if (seen.has(key)) refuse('duplicate HTML attribute');
        seen.add(key);
        if (/^on/i.test(key) || key === 'srcdoc') refuse('active HTML attribute');
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
              destination(candidate.trim().split(/\s+/)[0] ?? '', key);
            }
          } else {
            destination(value, key);
          }
        }
      }
      offset = tag.lastIndex;
      text += ' '; // Keep separate text nodes separate for placeholder checks.
    }
    text += source.slice(offset);
    const decodedText = decode(text);
    for (const match of decodedText.matchAll(ACTION_URL)) {
      if (field !== 'body_text') refuse('action URL outside an anchor href or text body');
      const before = decodedText[match.index - 1];
      const after = decodedText[match.index + match[0].length];
      if ((before && !/\s/.test(before)) || (after && !/\s/.test(after))) {
        refuse('concatenated action URL in text');
      }
    }
    if (/url\s*\(/i.test(decodedText)) css(decodedText);
  }
}
