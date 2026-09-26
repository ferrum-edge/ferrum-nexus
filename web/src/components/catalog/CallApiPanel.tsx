import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { AUTH_PLUGIN_LABELS, type AuthPluginType } from '@ferrum-nexus/shared';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { CopyField } from '../ui/CopyField';
import { Icon } from '../ui/Icon';

export interface CallApiPanelProps {
  /** Absolute gateway URL, or `null` when no public origin is configured. */
  invokeUrl: string | null;
  /** `/<namespace>/<slug>` — always known, even without an origin. */
  listenPath: string;
  authPlugin: AuthPluginType;
  /**
   * Gateway consumer username of the identity the example calls as:
   * `nexus-user-<id>` for the account, `nexus-app-<id>` for an application.
   * It must be the identity that holds the access — an application's grant is
   * on that application's consumer only (issue #374).
   */
  consumer: string;
  /** Who that consumer is, in prose: "your account" or the application's name. */
  holder: string;
}

/**
 * Quote one argument for a POSIX shell.
 *
 * Single quotes keep everything literal; an embedded `'` closes the quote,
 * adds an escaped one and reopens it.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * How a client authenticates, per auth plugin.
 *
 * Mirrors the table in `docs/guides/client-guide.md`. Both Basic and JWT are
 * keyed on the **consumer** username (`nexus-user-<id>` or `nexus-app-<id>`),
 * not the portal email: a basic-auth credential on Edge has no username field
 * of its own, and the `jwt_auth` plugin identifies the caller by the `sub`
 * claim.
 */
interface AuthRecipe {
  /** The `curl` arguments that authenticate the example request. */
  curlAuth: string;
  /** Header name on its own, for the guidance list. */
  name: string;
  /** Credential type to issue on the credentials page. */
  credential: string;
  /** What the caller has to know beyond the header name. */
  note: ReactNode;
}

function authRecipe(authPlugin: AuthPluginType, consumer: string): AuthRecipe {
  switch (authPlugin) {
    case 'key_auth':
      return {
        curlAuth: `-H ${shellQuote('X-API-Key: <your key>')}`,
        name: 'X-API-Key',
        credential: 'keyauth',
        note: 'Send the key exactly as it was shown when you issued the credential.',
      };
    case 'basic_auth':
      // `--user` makes curl build `Authorization: Basic <base64(user:password)>`
      // itself; a literal `base64(...)` in a header would be sent as-is and
      // never authenticate (issue #375).
      return {
        curlAuth: `--user ${shellQuote(`${consumer}:<your password>`)}`,
        name: 'Authorization',
        credential: 'basicauth',
        note: (
          <>
            The username is the consumer username <code className="font-mono">{consumer}</code>,
            not your email. <code className="font-mono">--user</code> base64-encodes{' '}
            <code className="font-mono">username:password</code> into the{' '}
            <code className="font-mono">Authorization: Basic</code> header for you.
          </>
        ),
      };
    case 'jwt_auth':
      return {
        curlAuth: `-H ${shellQuote('Authorization: Bearer <token you sign>')}`,
        name: 'Authorization',
        credential: 'jwt',
        note: (
          <>
            Sign a short-lived HS256 token with the credential&rsquo;s secret; its{' '}
            <code className="font-mono">sub</code> claim must be{' '}
            <code className="font-mono">{consumer}</code>.
          </>
        ),
      };
  }
}

/**
 * The copyable example request: the same text is shown and copied, so what a
 * caller reads is exactly what runs.
 */
export function exampleRequest(
  target: string,
  authPlugin: AuthPluginType,
  consumer: string,
): string {
  return `curl ${shellQuote(target)} \\\n  ${authRecipe(authPlugin, consumer).curlAuth}`;
}

/** Copy-to-clipboard affordance for the whole example request. */
function CopySnippetButton({ value }: { value: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the
      // snippet stays selectable so it can be copied by hand.
      setCopied(false);
    }
  }, [value]);

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => void copy()}
      aria-label={copied ? 'Example request copied' : 'Copy example request'}
    >
      <Icon name={copied ? 'check' : 'copy'} className={copied ? 'text-success' : undefined} />
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

/** Label/value pair in the compact guidance list under the snippet. */
function Guidance({ term, children }: { term: string; children: ReactNode }): ReactElement {
  return (
    <>
      <dt className="text-xs font-medium tracking-wide text-fg-subtle uppercase sm:pt-0.5">
        {term}
      </dt>
      <dd className="min-w-0 text-sm break-words text-fg-muted">{children}</dd>
    </>
  );
}

/**
 * Where to send requests for one API, and what to put in the auth header.
 *
 * Requests go to the gateway's **proxy listener**, which is a different address
 * from the portal serving this page. When the operator has not published that
 * address, the panel shows the listen path and says to ask — guessing a port
 * would only send a client somewhere nothing answers.
 */
export function CallApiPanel({
  invokeUrl,
  listenPath,
  authPlugin,
  consumer,
  holder,
}: CallApiPanelProps): ReactElement {
  const recipe = authRecipe(authPlugin, consumer);
  const target = invokeUrl ?? `<gateway address>${listenPath}`;
  const snippet = exampleRequest(target, authPlugin, consumer);

  return (
    <Card>
      <CardHeader
        title="Call this API"
        icon="code"
        description="Requests go to the gateway, not to this portal."
        actions={<Badge tone="info">{AUTH_PLUGIN_LABELS[authPlugin]}</Badge>}
      />
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
              Example request
            </span>
            <CopySnippetButton value={snippet} />
          </div>
          <pre className="overflow-x-auto rounded-md border border-border bg-inset p-3 font-mono text-xs leading-relaxed text-fg">
            <code>{snippet}</code>
          </pre>
        </div>

        {invokeUrl ? (
          <>
            <CopyField label="Invoke URL" value={invokeUrl} />
            <p className="text-sm text-fg-muted">
              Append the operation path from the OpenAPI document, e.g.{' '}
              <code className="font-mono text-xs">{invokeUrl}/some-path</code>.
            </p>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
              Gateway path
            </span>
            <code className="block overflow-x-auto rounded-md border border-border bg-inset px-3 py-2 font-mono text-xs text-fg">
              {listenPath}
            </code>
            <p className="text-sm text-fg-muted">
              This portal has no gateway address configured — ask your administrator for the gateway
              address, then append <code className="font-mono text-xs">{listenPath}</code>.
            </p>
          </div>
        )}

        <dl className="grid gap-x-4 gap-y-2 border-t border-border pt-4 sm:grid-cols-[8rem_1fr]">
          <Guidance term="Header">
            <code className="font-mono text-xs text-fg">{recipe.name}</code>
          </Guidance>
          <Guidance term="Credential">
            Issue a <strong className="font-medium text-fg">{recipe.credential}</strong> credential
            to {holder} from the credentials page.
          </Guidance>
          <Guidance term="Consumer">
            <code className="font-mono text-xs text-fg">{consumer}</code> — {holder}
          </Guidance>
          <Guidance term="Notes">{recipe.note}</Guidance>
        </dl>
      </CardBody>
    </Card>
  );
}
