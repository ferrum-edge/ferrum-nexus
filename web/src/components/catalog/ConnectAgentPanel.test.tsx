import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentToolList, ConnectAgentPanel, agentCredentialHeader } from './ConnectAgentPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('agent connection guidance', () => {
  it('copies the public endpoint and header-based config without putting credentials in URLs', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: copy },
    });
    render(
      <ConnectAgentPanel
        invokeUrl="https://gateway.example.test/nexus/items"
        listenPath="/nexus/items"
        slug="items"
        authPlugin="key_auth"
        consumer="nexus-app-123"
        holder="Orders app"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy VS Code .vscode/mcp.json' }));
    await waitFor(() => expect(copy).toHaveBeenCalledOnce());
    const config = JSON.parse(copy.mock.calls[0]![0] as string) as {
      servers: { items: { url: string; headers: Record<string, string> } };
    };
    expect(config.servers.items.url).toBe('https://gateway.example.test/nexus/items/mcp');
    expect(config.servers.items.headers).toEqual({ 'X-API-Key': '<your key>' });
    expect(screen.getByText(/credential issued to Orders app/)).toBeInTheDocument();
  });

  it('does not invent a host when no public gateway origin is configured', () => {
    render(
      <ConnectAgentPanel
        invokeUrl={null}
        listenPath="/nexus/items"
        slug="items"
        authPlugin="jwt_auth"
        consumer="nexus-user-123"
        holder="your account"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('/nexus/items/mcp');
    expect(screen.queryByRole('button', { name: 'Copy MCP endpoint URL' })).not.toBeInTheDocument();
    expect(agentCredentialHeader('basic_auth', 'nexus-app-123').hint).toContain('nexus-app-123');
    expect(agentCredentialHeader('jwt_auth', 'nexus-user-123').hint).toContain(
      'sub nexus-user-123',
    );
  });

  it('shows read-only and destructive grant coverage and renders provider text as text', () => {
    render(
      <AgentToolList
        slug="items"
        title="Tools covered by this grant"
        agents={{
          operations: [
            {
              path: '/items',
              method: 'GET',
              name: 'read',
              description: '<script>unsafe()</script>',
            },
            { path: '/items', method: 'POST', name: 'create', description: 'Create an item' },
          ],
        }}
      />,
    );
    expect(screen.getByRole('region', { name: 'Tools covered by this grant' })).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByText('Destructive')).toBeInTheDocument();
    expect(screen.getByText('<script>unsafe()</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
