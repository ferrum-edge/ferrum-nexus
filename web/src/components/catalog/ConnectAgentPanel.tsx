import type { ReactElement } from 'react';
import {
  agentEndpointPath,
  agentToolName,
  isReadOnlyAgentMethod,
  type ApiAgents,
  type AuthPluginType,
} from '@ferrum-nexus/shared';
import { Badge } from '../ui/Badge';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { CopyField } from '../ui/CopyField';
import { shellQuote } from './CallApiPanel';

export function AgentToolList({
  agents,
  slug,
  title = 'Agent tools',
}: {
  agents: ApiAgents;
  slug: string;
  title?: string;
}): ReactElement {
  return (
    <section aria-label={title}>
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      <ul className="flex flex-col gap-3">
        {agents.operations.map((tool) => (
          <li key={agentToolName(slug, tool)} className="rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-xs">{agentToolName(slug, tool)}</code>
              <Badge tone={isReadOnlyAgentMethod(tool.method) ? 'info' : 'warning'}>
                {isReadOnlyAgentMethod(tool.method) ? 'Read-only' : 'Destructive'}
              </Badge>
            </div>
            <p className="mt-2 text-sm text-fg-muted">{tool.description}</p>
            <p className="mt-1 font-mono text-xs text-fg-subtle">
              {tool.method} {tool.path}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Only placeholders: credentials belong in the client's protected local config. */
export function agentCredentialHeader(
  plugin: AuthPluginType,
  consumer: string,
): { name: string; value: string; hint: string } {
  if (plugin === 'key_auth') {
    return { name: 'X-API-Key', value: '<your key>', hint: 'Use your normal keyauth credential.' };
  }
  if (plugin === 'basic_auth') {
    return {
      name: 'Authorization',
      value: 'Basic <base64 consumer:password>',
      hint: `Base64-encode ${consumer}:<your password> from your basicauth credential.`,
    };
  }
  return {
    name: 'Authorization',
    value: 'Bearer <your signed token>',
    hint: `Sign a short-lived HS256 token with your jwt credential secret and sub ${consumer}.`,
  };
}

export function ConnectAgentPanel({
  invokeUrl,
  listenPath,
  slug,
  authPlugin,
  consumer,
  holder,
}: {
  invokeUrl: string | null;
  listenPath: string;
  slug: string;
  authPlugin: AuthPluginType;
  consumer: string;
  holder: string;
}): ReactElement {
  const header = agentCredentialHeader(authPlugin, consumer);
  const url = invokeUrl ? agentEndpointPath(invokeUrl) : null;
  const headers = { [header.name]: header.value };
  const vscode = url
    ? JSON.stringify({ servers: { [slug]: { type: 'http', url, headers } } }, null, 2)
    : null;
  const claude = url
    ? `claude mcp add --transport http ${shellQuote(slug)} ${shellQuote(url)} --header ${shellQuote(`${header.name}: ${header.value}`)}`
    : null;
  return (
    <Card>
      <CardHeader
        icon="external"
        title="Connect an agent"
        description={`Use the credential issued to ${holder}.`}
      />
      <CardBody className="flex flex-col gap-4">
        {url ? (
          <CopyField label="MCP endpoint URL" value={url} />
        ) : (
          <p role="status">
            The operator must configure the gateway public URL. Endpoint path:{' '}
            {agentEndpointPath(listenPath)}.
          </p>
        )}
        <CopyField label="Credential header" value={`${header.name}: ${header.value}`} />
        <p className="text-sm text-fg-muted">
          {header.hint} Access belongs to the approved identity. Keep credentials in headers; the
          endpoint URL contains no secret.
        </p>
        {vscode ? <CopyField label="VS Code .vscode/mcp.json" value={vscode} multiline /> : null}
        {claude ? <CopyField label="Claude Code command" value={claude} /> : null}
        <p className="text-xs text-fg-subtle">
          Replace placeholders locally. Portal sessions and Edge Admin credentials do not authenticate
          agent calls.
        </p>
      </CardBody>
    </Card>
  );
}
