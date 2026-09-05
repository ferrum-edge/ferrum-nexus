import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MassEmailRequest, MassEmailResponse } from '@ferrum-nexus/shared';
import { adminApi } from '../../lib/api';
import { AdminMassEmailPage } from './AdminMassEmailPage';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), push: vi.fn() }));

vi.mock('../../stores/toast', () => ({ useToast: () => toast }));
vi.mock('../../components/layout/RoleGuard', () => ({
  RoleGuard: ({ children }: { children: ReactNode }) => children,
}));

function renderComposer(subject = 'Announcement'): void {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AdminMassEmailPage />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText(/^Subject/), { target: { value: subject } });
  fireEvent.change(screen.getByLabelText(/^Plain-text body/), {
    target: { value: 'First announcement' },
  });
}

async function submit(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Review and send' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
}

describe('mass email campaign IDs', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('submits a maximum-length subject and resets the ID after each success', async () => {
    const send = vi.spyOn(adminApi, 'massEmail').mockResolvedValue({ enqueued: 2, recipients: 2 });
    const subject = 'S'.repeat(300);
    renderComposer(subject);
    expect(screen.getByLabelText(/^Subject/)).toHaveAttribute('maxlength', '300');
    await submit();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/^Plain-text body/), {
      target: { value: 'Second announcement' },
    });
    await submit();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(2));
    // Even an unchanged form represents a new send after successful completion.
    await submit();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(3));

    const requests = send.mock.calls.map(([request]) => request);
    expect(new Set(requests.map((request) => request.idempotency_key)).size).toBe(3);
    for (const request of requests) {
      expect(request.idempotency_key).toMatch(/^[0-9a-f]{32}$/);
      expect(request.subject).toBe(subject);
      expect(request.audience).toEqual({ scope: 'all' });
    }
    expect(requests.map((request) => request.body_text)).toEqual([
      'First announcement',
      'Second announcement',
      'Second announcement',
    ]);
  });

  it('reuses the ID after a lost response and reports already queued', async () => {
    const queued = new Set<string | undefined>();
    let loseResponse = true;
    const send = vi
      .spyOn(adminApi, 'massEmail')
      .mockImplementation(async (request: MassEmailRequest): Promise<MassEmailResponse> => {
        const enqueued = queued.has(request.idempotency_key) ? 0 : 2;
        queued.add(request.idempotency_key);
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError('Network connection lost');
        }
        return { enqueued, recipients: 2 };
      });
    renderComposer();
    await submit();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(toast.push).toHaveBeenCalledWith(
        'Mass email already queued',
        expect.objectContaining({ description: expect.stringContaining('No duplicate') }),
      ),
    );
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toEqual(send.mock.calls[0]?.[0]);
    expect(queued.size).toBe(1);
    expect(toast.success).not.toHaveBeenCalled();
    await submit();
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(queued.size).toBe(2);
  });

  it('surfaces unexpected deduplication of a fresh campaign', async () => {
    vi.spyOn(adminApi, 'massEmail').mockResolvedValue({ enqueued: 0, recipients: 2 });
    renderComposer();
    await submit();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Mass email unexpectedly deduplicated',
        expect.any(String),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
});
