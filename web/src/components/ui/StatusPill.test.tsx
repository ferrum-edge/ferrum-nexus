import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLE_ORDER } from '@ferrum-nexus/shared';
import {
  AccessModeBadge,
  RoleBadge,
  StatusPill,
  VisibilityBadge,
  statusLabel,
  visibilityLabel,
  type StatusValue,
} from './StatusPill';

afterEach(cleanup);

describe('StatusPill', () => {
  it('labels each status union member', () => {
    const cases: Array<[StatusValue, string]> = [
      ['pending', 'Pending'],
      ['approved', 'Approved'],
      ['denied', 'Denied'],
      ['cancelled', 'Cancelled'],
      ['active', 'Active'],
      ['revoked', 'Revoked'],
      ['retiring', 'Retiring'],
      ['published', 'Published'],
      ['retired', 'Retired'],
      ['disabled', 'Disabled'],
      ['sent', 'Sent'],
      ['failed', 'Failed'],
      ['ok', 'OK'],
      ['degraded', 'Degraded'],
      ['down', 'Down'],
      ['none', 'No access'],
      ['open', 'Open access'],
      ['granted', 'Granted'],
      ['owner', 'You own this'],
    ];
    for (const [status, label] of cases) expect(statusLabel(status)).toBe(label);
  });

  it('renders success tone styling for an active status', () => {
    render(<StatusPill status="active" />);
    const pill = screen.getByText('Active');
    expect(pill).toBeInTheDocument();
    expect(pill.className).toContain('bg-success-soft');
    expect(pill.className).toContain('text-success');
  });

  it('renders danger tone styling for a revoked status', () => {
    render(<StatusPill status="revoked" />);
    expect(screen.getByText('Revoked').className).toContain('text-danger');
  });
});

describe('RoleBadge', () => {
  it('uses the shared role labels for every role', () => {
    render(
      <>
        {ROLE_ORDER.map((role) => (
          <RoleBadge key={role} role={role} />
        ))}
      </>,
    );
    expect(screen.getByText('Client')).toBeInTheDocument();
    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Super Admin')).toBeInTheDocument();
  });
});

describe('VisibilityBadge', () => {
  it('labels every visibility for people, not with its raw value', () => {
    expect(visibilityLabel('public')).toBe('Public');
    // Unlisted, not "Internal": it is not secret (issue #288).
    expect(visibilityLabel('internal')).toBe('Unlisted');
    expect(visibilityLabel('private')).toBe('Private');
  });

  it('tones private as the one to notice', () => {
    render(<VisibilityBadge visibility="private" />);
    expect(screen.getByText('Private').className).toContain('text-danger');
  });
});

describe('AccessModeBadge', () => {
  it('renders open access as a neutral badge beside the requestable one', () => {
    render(
      <>
        <AccessModeBadge requestable />
        <AccessModeBadge requestable={false} />
      </>,
    );
    expect(screen.getByText('Requestable').className).toContain('bg-accent-soft');
    const open = screen.getByText('Open');
    expect(open.className).toContain('bg-neutral-soft');
    expect(open.className).toContain('rounded-full');
  });
});
