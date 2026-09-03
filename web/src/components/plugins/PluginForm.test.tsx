/**
 * The generic plugin form is the one place a descriptor becomes an input, a
 * draft becomes a request body, and a bad value becomes a message — and it is
 * a pure component, so all three are testable without a server.
 *
 * The assertions that matter are the ones that would otherwise only fail as a
 * gateway `400`: an optional field the provider cleared must be **omitted**
 * from the body rather than sent empty, and the closed key set must be exactly
 * what the descriptor declares.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findProviderPlugin, type ProviderPluginDescriptor } from '@ferrum-nexus/shared';
import {
  FORM_ERROR_KEY,
  PluginForm,
  draftFor,
  draftToConfig,
  validateDraft,
  type PluginDraft,
} from './PluginForm';

afterEach(cleanup);

/** A palette descriptor by name, failing loudly if the catalog moved. */
function descriptor(name: string): ProviderPluginDescriptor {
  const found = findProviderPlugin(name);
  if (!found) throw new Error(`no palette descriptor for ${name}`);
  return found;
}

describe('draftFor', () => {
  it('seeds every field from the descriptor defaults when nothing is saved', () => {
    const draft = draftFor(descriptor('bot_detection'), null);
    expect(draft.allow_missing_user_agent).toBe(true);
    expect(draft.custom_response_code).toBe('403');
    // A free-text list is edited one entry per line; a closed one as an array.
    expect(draft.blocked_patterns).toContain('curl\n');
    expect(draft.allow_list).toBe('');
  });

  it('prefers the saved config over the defaults', () => {
    const draft = draftFor(descriptor('response_caching'), {
      ttl_seconds: 900,
      cacheable_methods: ['GET', 'HEAD'],
      cacheable_status_codes: [200],
    });
    expect(draft.ttl_seconds).toBe('900');
    expect(draft.cacheable_methods).toEqual(['GET', 'HEAD']);
    expect(draft.cacheable_status_codes).toEqual(['200']);
  });
});

describe('draftToConfig', () => {
  it('sends exactly the keys the descriptor declares, with the right types', () => {
    const spec = descriptor('response_caching');
    const config = draftToConfig(spec, {
      ttl_seconds: '60',
      cacheable_methods: ['GET'],
      cacheable_status_codes: ['200', '404'],
      cache_key_include_query: true,
      vary_by_headers: 'accept-language\naccept',
    });
    expect(config).toEqual({
      ttl_seconds: 60,
      cacheable_methods: ['GET'],
      cacheable_status_codes: [200, 404],
      cache_key_include_query: true,
      vary_by_headers: ['accept-language', 'accept'],
    });
  });

  it('omits an optional field the provider cleared rather than sending it empty', () => {
    // `content_security_policy: ''` would make the gateway emit an empty CSP
    // header; an absent key makes it emit none at all.
    const config = draftToConfig(descriptor('security_headers'), {
      content_type_options: true,
      frame_options: 'DENY',
      referrer_policy: 'no-referrer',
      hsts: false,
      content_security_policy: '',
      permissions_policy: '   ',
    });
    expect(config).not.toHaveProperty('content_security_policy');
    expect(config).not.toHaveProperty('permissions_policy');
    expect(config).toEqual({
      content_type_options: true,
      frame_options: 'DENY',
      referrer_policy: 'no-referrer',
      hsts: false,
    });
  });

  it('drops blank lines from a free-text list', () => {
    const config = draftToConfig(descriptor('ip_restriction'), {
      allow: '203.0.113.0/24\n\n  198.51.100.7  \n',
      deny: '',
      mode: 'allow_first',
    });
    expect(config.allow).toEqual(['203.0.113.0/24', '198.51.100.7']);
    expect(config).not.toHaveProperty('deny');
  });
});

describe('validateDraft', () => {
  it('accepts each descriptor’s own defaults', () => {
    for (const name of ['security_headers', 'compression', 'correlation_id', 'response_caching']) {
      const spec = descriptor(name);
      expect(validateDraft(spec, draftFor(spec, null))).toEqual({});
    }
  });

  it('reports an integer outside the descriptor bounds', () => {
    const spec = descriptor('request_size_limiting');
    expect(validateDraft(spec, { max_bytes: '0' }).max_bytes).toMatch(/between/);
    expect(validateDraft(spec, { max_bytes: '1.5' }).max_bytes).toBe('Enter a whole number');
    expect(validateDraft(spec, { max_bytes: '1024' })).toEqual({});
  });

  it('reports a required field left empty', () => {
    expect(validateDraft(descriptor('request_size_limiting'), { max_bytes: '' }).max_bytes).toBe(
      'Required',
    );
  });

  it('reports a list entry the gateway would not accept', () => {
    const errors = validateDraft(descriptor('compression'), {
      algorithms: ['gzip'],
      min_content_length: '256',
      content_types: 'application/json\nnot a media type',
    });
    expect(errors.content_types).toMatch(/not in a form the gateway accepts/);
  });

  it('reports a string that fails the descriptor pattern', () => {
    const errors = validateDraft(descriptor('correlation_id'), {
      header_name: 'x request id',
      echo_downstream: true,
    });
    expect(errors.header_name).toMatch(/does not accept/);
  });

  it('reports ip_restriction with both lists empty as a whole-plugin problem', () => {
    const errors = validateDraft(descriptor('ip_restriction'), {
      allow: '',
      deny: '',
      mode: 'allow_first',
    });
    expect(errors[FORM_ERROR_KEY]).toMatch(/restrict nobody/);
    expect(errors.allow).toBeUndefined();
  });

  it('reports bot_detection configured to block nothing', () => {
    const spec = descriptor('bot_detection');
    const draft: PluginDraft = {
      blocked_patterns: '',
      allow_list: 'GoogleBot',
      allow_missing_user_agent: true,
      custom_response_code: '403',
    };
    expect(validateDraft(spec, draft)[FORM_ERROR_KEY]).toMatch(/blocks nothing/);
    // Rejecting missing-UA requests gives the filter something to do.
    expect(validateDraft(spec, { ...draft, allow_missing_user_agent: false })).toEqual({});
  });
});

describe('<PluginForm>', () => {
  function renderForm(name: string, overrides: PluginDraft = {}) {
    const spec = descriptor(name);
    const draft = { ...draftFor(spec, null), ...overrides };
    const onChange = vi.fn();
    render(
      <PluginForm
        descriptor={spec}
        draft={draft}
        errors={validateDraft(spec, draft)}
        onChange={onChange}
      />,
    );
    return { spec, onChange };
  }

  it('renders one labelled control per descriptor field', () => {
    const { spec } = renderForm('correlation_id');
    for (const field of spec.fields) {
      expect(screen.getByLabelText(field.label, { exact: false })).toBeInTheDocument();
    }
  });

  it('renders a closed list as one checkbox per option', () => {
    renderForm('compression');
    expect(screen.getByLabelText('gzip')).toBeInTheDocument();
    expect(screen.getByLabelText('Brotli')).toBeInTheDocument();
  });

  it('reports edits by the descriptor’s Edge config key', () => {
    const { onChange } = renderForm('correlation_id');
    fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'x-trace-id' } });
    expect(onChange).toHaveBeenCalledWith('header_name', 'x-trace-id');

    fireEvent.click(screen.getByLabelText('Echo the id on responses'));
    expect(onChange).toHaveBeenCalledWith('echo_downstream', false);
  });

  it('shows a field message next to the field that caused it', () => {
    renderForm('request_size_limiting', { max_bytes: '0' });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/between 1 and/);
  });

  it('shows a whole-plugin message above the fields', () => {
    renderForm('ip_restriction', { allow: '', deny: '' });
    expect(screen.getByRole('alert').textContent).toMatch(/restrict nobody/);
  });
});
