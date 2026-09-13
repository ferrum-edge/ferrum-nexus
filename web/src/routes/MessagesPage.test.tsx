import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_SIZE, type ListThreadsResponse } from '@ferrum-nexus/shared';
import { THREAD, THREAD_RESPONSE } from '../../test/fixtures';
import { changeField, clearClients, deferred, renderPage } from '../../test/helpers';
import { threadsApi } from '../lib/api';
import { MessagesPage } from './MessagesPage';

const navigate = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-router', async () => {
  const { TestLink } = await import('../../test/helpers');
  return { Link: TestLink, useNavigate: () => navigate };
});
vi.mock('../stores/auth', () => ({ useAuth: () => ({ user: { id: 'user-1' } }) }));

beforeEach(() => {
  navigate.mockReset();
  vi.spyOn(threadsApi, 'list').mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(threadsApi, 'create').mockResolvedValue(THREAD_RESPONSE);
});

afterEach(() => {
  cleanup();
  clearClients();
  vi.restoreAllMocks();
});

function compose(): void {
  fireEvent.click(screen.getAllByRole('button', { name: 'New message' })[0]!);
}

describe('conversation inbox', () => {
  it('loads conversations with their counterpart, API, preview, and destination', async () => {
    const pending = deferred<ListThreadsResponse>();
    vi.mocked(threadsApi.list).mockImplementationOnce(() => pending.promise);
    renderPage(<MessagesPage />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversations');
    await act(async () => pending.resolve({ items: [THREAD], total: 1 }));
    const link = await screen.findByRole('link', { name: /Invoice question/ });
    expect(link).toHaveAttribute('href', '/messages/thread-1');
    expect(within(link).getByText('Billing team · Billing API')).toBeInTheDocument();
    expect(within(link).getByText('Can I export invoices?')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('paginates and displays administrator threads without optional metadata', async () => {
    vi.mocked(threadsApi.list).mockImplementation(async (query = {}) => ({
      items: query.offset
        ? [
            {
              ...THREAD,
              id: 'thread-2',
              subject: 'Portal support',
              api: undefined,
              participants: undefined,
              last_message_preview: null,
              last_message_at: null,
            },
          ]
        : [{ ...THREAD, last_message_preview: 'x'.repeat(150) }],
      total: DEFAULT_PAGE_SIZE + 1,
    }));
    renderPage(<MessagesPage />);
    await screen.findByText('Invoice question');
    expect(screen.getByText(`${'x'.repeat(119)}…`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Portal support');
    expect(screen.getByText('Portal administrators')).toBeInTheDocument();
    expect(threadsApi.list).toHaveBeenLastCalledWith({
      limit: DEFAULT_PAGE_SIZE,
      offset: DEFAULT_PAGE_SIZE,
    });
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await screen.findByText('Invoice question');
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('validates a message and navigates to the new administrator conversation', async () => {
    renderPage(<MessagesPage />);
    await screen.findByText('No conversations yet');
    compose();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This message goes to the portal administrators.');
    expect(within(dialog).getByRole('button', { name: 'Send' })).toBeDisabled();
    changeField(/Message/, '   ');
    expect(within(dialog).getByRole('button', { name: 'Send' })).toBeDisabled();
    changeField(/Subject/, '  Support question  ');
    changeField(/Message/, '  Please help with access  ');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(threadsApi.create).toHaveBeenCalledWith({
      subject: 'Support question',
      body: 'Please help with access',
      recipient_user_id: null,
      api_id: null,
    });
    expect(navigate).toHaveBeenCalledWith({
      to: '/messages/$threadId',
      params: { threadId: THREAD.id },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    compose();
    expect(screen.getByLabelText(/Message/)).toHaveValue('');
  });

  it('uses a default subject and preserves a failed draft for retry', async () => {
    vi.mocked(threadsApi.create).mockRejectedValueOnce(new Error('Service unavailable'));
    renderPage(<MessagesPage />);
    await screen.findByText('No conversations yet');
    compose();
    changeField(/Subject/, '   ');
    changeField(/Message/, 'Please help');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(threadsApi.create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.getByLabelText(/Message/)).toHaveValue('Please help');
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByText('Message sent')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(threadsApi.create).toHaveBeenLastCalledWith({
      subject: 'New conversation',
      body: 'Please help',
      recipient_user_id: null,
      api_id: null,
    });
  });

  it('cancels composition without sending a message', async () => {
    renderPage(<MessagesPage />);
    await screen.findByText('No conversations yet');
    compose();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(threadsApi.create).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
