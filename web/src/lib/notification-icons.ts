import type { NotificationType } from '@ferrum-nexus/shared';
import type { IconName } from '../components/ui/Icon';

/** The glyph each kind of notification is listed with, in the bell and on its page. */
export const NOTIFICATION_ICONS: Readonly<Record<NotificationType, IconName>> = {
  access_request_created: 'inbox',
  access_request_approved: 'grant',
  access_request_denied: 'x',
  access_revoked: 'lock',
  message_received: 'message',
  credential_rotated: 'key',
  api_published: 'catalog',
  api_spec_updated: 'spec',
  system: 'bell',
};

/** The glyph for `type`, falling back to the bell for a type this build does not know. */
export function notificationIcon(type: NotificationType): IconName {
  return NOTIFICATION_ICONS[type] ?? 'bell';
}
