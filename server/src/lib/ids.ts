/** Identity and timestamp helpers — string UUIDs and ISO-8601 strings everywhere. */

import { randomUUID } from 'node:crypto';

/** A fresh string UUID, used as the primary key of every Nexus row. */
export function newId(): string {
  return randomUUID();
}

/** The current instant as an ISO-8601 string (`2026-08-31T12:00:00.000Z`). */
export function nowIso(): string {
  return new Date().toISOString();
}

/** `nowIso()` shifted by `seconds`, for expiry stamps. */
export function isoInSeconds(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}
