/**
 * The email-template editor binds its fields to the template they were loaded
 * from. The selector moves independently, so a failed load for a newly chosen
 * template used to leave the previous template's content in the editor with
 * Save enabled — and saving wrote it under the new key (issue #594).
 *
 * It also resets an overridden template to the built-in default, and offers
 * that only for a template that has an override.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmailTemplate,
  EmailTemplateKey,
  GetEmailTemplateResponse,
} from '@ferrum-nexus/shared';
import { changeField, clearClients, renderPage } from '../../../test/helpers';
import { adminApi } from '../../lib/api';
import { TemplatesTab } from './AdminSettingsPage';

vi.mock('../../components/ui/Select', async () => {
  const { NativeLabeledSelect } = await import('../../../test/helpers');
  return { LabeledSelect: NativeLabeledSelect };
});

function template(key: EmailTemplateKey, subject: string): GetEmailTemplateResponse {
  const value: EmailTemplate = {
    id: `template-${key}`,
    key,
    subject,
    body_html: `<p>${subject} html</p>`,
    body_text: `${subject} text`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
  return { template: value, available_variables: ['portal_name'] };
}

let failing: Set<EmailTemplateKey>;
let overridden: Set<EmailTemplateKey>;

beforeEach(() => {
  failing = new Set();
  overridden = new Set();
  vi.spyOn(adminApi, 'listEmailTemplates').mockImplementation(async () => ({
    templates: [...overridden].map((key) => template(key, 'Custom').template),
    keys: ['verification', 'password_reset'],
  }));
  vi.spyOn(adminApi, 'getEmailTemplate').mockImplementation(async (key) => {
    if (failing.has(key)) throw new Error('Template unavailable');
    return template(key, key === 'verification' ? 'Verify your email' : 'Reset your password');
  });
  vi.spyOn(adminApi, 'updateEmailTemplate').mockImplementation(async (key, body) => ({
    template: { ...template(key, body.subject).template, ...body },
  }));
  vi.spyOn(adminApi, 'resetEmailTemplate').mockImplementation(async (key) => {
    overridden.delete(key);
    return { template: template(key, 'Default').template };
  });
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

const save = (): HTMLElement => screen.getByRole('button', { name: 'Save template' });
const resetButton = (): HTMLElement => screen.getByRole('button', { name: 'Reset to default' });

describe('email template editor', () => {
  it('never saves one template under another key after a failed load', async () => {
    renderPage(<TemplatesTab />);
    expect(await screen.findByDisplayValue('Verify your email')).toBeInTheDocument();
    expect(save()).toBeEnabled();

    failing.add('password_reset');
    changeField('Template', 'password_reset');
    expect(await screen.findByText('Template unavailable')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Verify your email')).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    fireEvent.click(save());
    expect(adminApi.updateEmailTemplate).not.toHaveBeenCalled();

    // A successful retry loads the template that is actually selected.
    failing.delete('password_reset');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByDisplayValue('Reset your password')).toBeInTheDocument();
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    await waitFor(() =>
      expect(adminApi.updateEmailTemplate).toHaveBeenCalledWith('password_reset', {
        subject: 'Reset your password',
        body_html: '<p>Reset your password html</p>',
        body_text: 'Reset your password text',
      }),
    );

    // Switching back shows the first template again, not the second.
    changeField('Template', 'verification');
    expect(await screen.findByDisplayValue('Verify your email')).toBeInTheDocument();
  });

  it('offers nothing to save when the first load fails', async () => {
    failing.add('verification');
    renderPage(<TemplatesTab />);
    expect(await screen.findByText('Template unavailable')).toBeInTheDocument();
    expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    expect(adminApi.updateEmailTemplate).not.toHaveBeenCalled();
  });

  it('offers no reset for a template without an override', async () => {
    renderPage(<TemplatesTab />);
    expect(await screen.findByDisplayValue('Verify your email')).toBeInTheDocument();
    await waitFor(() => expect(adminApi.listEmailTemplates).toHaveBeenCalled());
    expect(resetButton()).toBeDisabled();
    fireEvent.click(resetButton());
    expect(adminApi.resetEmailTemplate).not.toHaveBeenCalled();
  });

  it('resets an overridden template after confirmation', async () => {
    overridden.add('verification');
    renderPage(<TemplatesTab />);
    expect(await screen.findByDisplayValue('Verify your email')).toBeInTheDocument();
    await waitFor(() => expect(resetButton()).toBeEnabled());

    fireEvent.click(resetButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(adminApi.resetEmailTemplate).toHaveBeenCalledWith('verification'));
    // The list is read again, and with the override gone there is nothing left
    // to reset.
    await waitFor(() => expect(resetButton()).toBeDisabled());
  });
});
