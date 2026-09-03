import type { ReactElement } from 'react';
import {
  AUTH_PLUGIN_LABELS,
  consumerUsernameForUser,
  type AuthPluginType,
} from '@ferrum-nexus/shared';
import { useAuth } from '../../stores/auth';
import { Badge } from '../ui/Badge';
import { Card, CardBody, CardHeader } from '../ui/Card';
import { CopyField } from '../ui/CopyField';

export interface CallApiPanelProps {
  /** Absolute gateway URL, or `null` when no public origin is configured. */
  invokeUrl: string | null;
  /** `/<namespace>/<slug>` — always known, even without an origin. */
  listenPath: string;
  authPlugin: AuthPluginType;
}

/**
 * The header a client sends, per auth plugin.
 *
 * Mirrors the table in `docs/guides/client-guide.md`. Both Basic and JWT are
 * keyed on the **consumer** username (`nexus-user-<id>`), not the portal email:
 * a basic-auth credential on Edge has no username field of its own, and the
 * `jwt_auth` plugin identifies the caller by the `sub` claim.
 */
function AuthRecipe({ authPlugin }: { authPlugin: AuthPluginType }): ReactElement {
  const { user } = useAuth();
  const consumer = user ? consumerUsernameForUser(user.id) : 'nexus-user-<your id>';

  switch (authPlugin) {
    case 'key_auth':
      return (
        <div className="flex flex-col gap-1.5">
          <code className="block overflow-x-auto rounded-md border border-border bg-inset px-3 py-2 font-mono text-xs text-fg">
            X-API-Key: &lt;your key&gt;
          </code>
          <p className="text-sm text-fg-muted">
            Send the key from a <strong className="font-medium text-fg">keyauth</strong> credential.
          </p>
        </div>
      );
    case 'basic_auth':
      return (
        <div className="flex flex-col gap-1.5">
          <code className="block overflow-x-auto rounded-md border border-border bg-inset px-3 py-2 font-mono text-xs text-fg">
            Authorization: Basic base64({consumer}:&lt;your password&gt;)
          </code>
          <p className="text-sm text-fg-muted">
            The username is your consumer username{' '}
            <code className="font-mono text-xs">{consumer}</code>, not your email — issue a{' '}
            <strong className="font-medium text-fg">basicauth</strong> credential for the password.
          </p>
        </div>
      );
    case 'jwt_auth':
      return (
        <div className="flex flex-col gap-1.5">
          <code className="block overflow-x-auto rounded-md border border-border bg-inset px-3 py-2 font-mono text-xs text-fg">
            Authorization: Bearer &lt;token you sign&gt;
          </code>
          <p className="text-sm text-fg-muted">
            Sign a short-lived HS256 token with a{' '}
            <strong className="font-medium text-fg">jwt</strong> credential&rsquo;s secret. Its{' '}
            <code className="font-mono text-xs">sub</code> claim must be{' '}
            <code className="font-mono text-xs">{consumer}</code>.
          </p>
        </div>
      );
  }
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
}: CallApiPanelProps): ReactElement {
  return (
    <Card>
      <CardHeader
        title="Call this API"
        description="Requests go to the gateway, not to this portal."
        actions={<Badge tone="info">{AUTH_PLUGIN_LABELS[authPlugin]}</Badge>}
      />
      <CardBody className="flex flex-col gap-4">
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

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
            Authentication
          </span>
          <AuthRecipe authPlugin={authPlugin} />
        </div>
      </CardBody>
    </Card>
  );
}
