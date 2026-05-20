import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { NexusStore, UserRow } from '../db/store.js';
import type { ResolvedConfig } from '../config/index.js';
import { badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import type { PortalUser, UserRole } from '@ferrum-nexus/shared';
import { randomToken } from '../lib/crypto.js';
import type { EmailService } from '../email/service.js';
import type { AuditService } from '../audit/service.js';
import type { NotificationService } from '../notifications/service.js';

export const RegistrationInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
  name: z.string().min(1).max(255).optional(),
  phone: z.string().max(64).optional(),
  desiredRole: z.enum(['client', 'provider']).default('client'),
  captchaToken: z.string().optional(),
});
export type RegistrationInput = z.infer<typeof RegistrationInput>;

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const ContactUpdate = z.object({
  name: z.string().min(1).max(255).optional(),
  phone: z.string().max(64).optional(),
});

export interface UsersService {
  register(input: RegistrationInput): Promise<{ user: PortalUser; verifyToken: string | null }>;
  verifyEmail(token: string): Promise<PortalUser>;
  login(input: LoginInput): Promise<PortalUser>;
  toPortalUser(row: UserRow, roles: UserRole[]): Promise<PortalUser>;
  loadById(id: string): Promise<PortalUser>;
  updateContact(id: string, patch: { name?: string; phone?: string }): Promise<PortalUser>;
  updatePassword(id: string, currentPassword: string, newPassword: string): Promise<void>;
  startPasswordReset(email: string): Promise<{ token: string; userId: string } | null>;
  completePasswordReset(token: string, newPassword: string): Promise<void>;
  setStatus(id: string, status: UserRow['status']): Promise<PortalUser>;
  setRoles(id: string, roles: UserRole[]): Promise<PortalUser>;
}

// Lazily computed argon2id hash used to equalize login timing when the
// supplied email does not match any user. Verifying against a real hash takes
// the same time as a wrong-password verify, preventing user enumeration via
// response timing. The plaintext is a random value; no real account uses it.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = argon2.hash(`nexus-dummy-${Math.random()}`, { type: argon2.argon2id });
  }
  return dummyHashPromise;
}

export function createUsersService(
  config: ResolvedConfig,
  store: NexusStore,
  emailService: EmailService,
  audit: AuditService,
  notifications: NotificationService,
): UsersService {
  const normalizeEmail = (email: string): string => email.trim().toLowerCase();

  const toPortalUser = async (row: UserRow, roles: UserRole[]): Promise<PortalUser> => ({
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    status: row.status,
    emailVerifiedAt: row.email_verified_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    roles,
    organizationId: row.organization_id,
  });

  const register: UsersService['register'] = async (input) => {
    const emailNormalized = normalizeEmail(input.email);
    const existing = await store.users.findByEmail(emailNormalized);
    if (existing) throw conflict('email_taken', 'An account with that email already exists');

    const userId = uuid();
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    // First user becomes super_admin automatically (bootstrap).
    const totalUsers = await store.users.count();
    const initialRoles: UserRole[] =
      totalUsers === 0 ? ['admin', 'super_admin', input.desiredRole] : [input.desiredRole];

    const row = await store.users.insert({
      id: userId,
      email: input.email,
      email_normalized: emailNormalized,
      name: input.name ?? null,
      phone: input.phone ?? null,
      status: 'pending',
      email_verified_at: null,
      password_hash: passwordHash,
      last_login_at: null,
      failed_login_count: 0,
      organization_id: null,
    });
    await store.userRoles.setRoles(userId, initialRoles);
    await audit.record(null, {
      action: 'user.register',
      targetType: 'user',
      targetId: userId,
      after: { email: input.email, roles: initialRoles },
    });

    const settings = await loadAppSettings(store);
    const requireVerification = settings.emailVerificationRequired;
    if (requireVerification) {
      const token = randomToken(24);
      await store.verifications.createEmailToken({
        token,
        user_id: userId,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        consumed_at: null,
      });
      const verifyUrl = `${config.publicUrl}/verify-email?token=${token}`;
      await emailService.enqueue({
        to: input.email,
        templateKey: 'registration_confirmed',
        vars: { name: input.name ?? input.email, verifyUrl },
      });
      await notifications.push({
        recipientId: userId,
        type: 'registration_confirmed',
        payload: { verifyUrl },
      });
      return { user: await toPortalUser(row, initialRoles), verifyToken: token };
    }

    await store.users.markEmailVerified(userId, new Date().toISOString());
    const fresh = await store.users.findById(userId);
    return { user: await toPortalUser(fresh!, initialRoles), verifyToken: null };
  };

  const verifyEmail: UsersService['verifyEmail'] = async (token) => {
    const record = await store.verifications.findEmailToken(token);
    if (!record) throw notFound('Verification token not found');
    if (record.consumed_at) throw badRequest('token_consumed', 'Verification link already used');
    if (new Date(record.expires_at).getTime() < Date.now()) {
      throw badRequest('token_expired', 'Verification link expired');
    }
    await store.users.markEmailVerified(record.user_id, new Date().toISOString());
    await store.verifications.consumeEmailToken(token, new Date().toISOString());
    const user = await store.users.findById(record.user_id);
    const roles = await store.userRoles.forUser(record.user_id);
    return toPortalUser(user!, roles);
  };

  const login: UsersService['login'] = async (input) => {
    const emailNormalized = normalizeEmail(input.email);
    const user = await store.users.findByEmail(emailNormalized);
    if (!user) {
      // Verify against a dummy hash so a missing account takes the same time
      // as one with a wrong password — prevents email enumeration.
      const dummy = await getDummyHash();
      await argon2.verify(dummy, input.password).catch(() => false);
      throw unauthorized('Invalid email or password');
    }
    if (user.status === 'disabled') throw unauthorized('Account disabled');
    if (user.failed_login_count >= 10) {
      throw unauthorized('Too many failed attempts. Reset your password to continue.');
    }
    let ok = false;
    try {
      ok = await argon2.verify(user.password_hash, input.password);
    } catch {
      ok = false;
    }
    if (!ok) {
      await store.users.recordFailedLogin(user.id);
      throw unauthorized('Invalid email or password');
    }
    if (user.status === 'pending') {
      throw unauthorized('Verify your email to activate your account');
    }
    await store.users.recordLogin(user.id, new Date().toISOString());
    const roles = await store.userRoles.forUser(user.id);
    return toPortalUser({ ...user, last_login_at: new Date().toISOString() }, roles);
  };

  const loadById: UsersService['loadById'] = async (id) => {
    const user = await store.users.findById(id);
    if (!user) throw notFound('User not found');
    const roles = await store.userRoles.forUser(id);
    return toPortalUser(user, roles);
  };

  const updateContact: UsersService['updateContact'] = async (id, patch) => {
    const validated = ContactUpdate.parse(patch);
    const updated = await store.users.updateContact(id, validated);
    const roles = await store.userRoles.forUser(id);
    return toPortalUser(updated, roles);
  };

  const updatePassword: UsersService['updatePassword'] = async (id, currentPassword, newPassword) => {
    const user = await store.users.findById(id);
    if (!user) throw notFound('User not found');
    const ok = await argon2.verify(user.password_hash, currentPassword).catch(() => false);
    if (!ok) throw unauthorized('Current password is incorrect');
    if (newPassword.length < 8) throw badRequest('weak_password', 'Password must be 8+ characters');
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await store.users.updatePassword(id, hash);
  };

  const startPasswordReset: UsersService['startPasswordReset'] = async (email) => {
    const user = await store.users.findByEmail(normalizeEmail(email));
    // Generate the token unconditionally so the timing of this branch matches
    // the existing-user branch up to the FS-bound randomBytes() call.
    const token = randomToken(24);
    if (!user) {
      // Burn roughly the same wall-clock as the create-token + enqueue path so
      // an attacker can't enumerate accounts via response timing.
      const dummy = await getDummyHash();
      await argon2.verify(dummy, token).catch(() => false);
      return null;
    }
    await store.verifications.createPasswordReset({
      token,
      user_id: user.id,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      consumed_at: null,
    });
    const resetUrl = `${config.publicUrl}/reset-password?token=${token}`;
    await emailService.enqueue({
      to: user.email,
      templateKey: 'password_reset',
      vars: { name: user.name ?? user.email, resetUrl },
    });
    return { token, userId: user.id };
  };

  const completePasswordReset: UsersService['completePasswordReset'] = async (token, newPassword) => {
    const reset = await store.verifications.findPasswordReset(token);
    if (!reset) throw notFound('Reset token not found');
    if (reset.consumed_at) throw badRequest('token_consumed', 'Reset link already used');
    if (new Date(reset.expires_at).getTime() < Date.now()) {
      throw badRequest('token_expired', 'Reset link expired');
    }
    if (newPassword.length < 8) throw badRequest('weak_password', 'Password must be 8+ characters');
    const hash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await store.users.updatePassword(reset.user_id, hash);
    await store.verifications.consumePasswordReset(token, new Date().toISOString());
    await store.sessions.deleteForUser(reset.user_id);
  };

  const setStatus: UsersService['setStatus'] = async (id, status) => {
    await store.users.updateStatus(id, status);
    if (status === 'disabled') await store.sessions.deleteForUser(id);
    return loadById(id);
  };

  const setRoles: UsersService['setRoles'] = async (id, roles) => {
    await store.userRoles.setRoles(id, roles);
    return loadById(id);
  };

  return {
    register,
    verifyEmail,
    login,
    toPortalUser,
    loadById,
    updateContact,
    updatePassword,
    startPasswordReset,
    completePasswordReset,
    setStatus,
    setRoles,
  };
}

export async function loadAppSettings(store: NexusStore): Promise<{
  emailVerificationRequired: boolean;
  registrationEnabled: boolean;
}> {
  return {
    emailVerificationRequired: ((await store.settings.get<boolean>('emailVerificationRequired')) ?? true) === true,
    registrationEnabled: ((await store.settings.get<boolean>('registrationEnabled')) ?? true) === true,
  };
}
