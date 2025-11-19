import { DecodedIdToken } from 'firebase-admin/auth';
import { Auth, TenantAwareAuth } from '../lib/auth';
import { AuthManager } from '../lib/auth-manager';
import { buildAuthData } from '../lib/https/_internal/util';
import { encodeIdToken } from '../lib/https/jwt';

const BASE_NOW_MS = 1_700_000_000_000; // fixed epoch for deterministic tests
const BASE_NOW_SEC = Math.floor(BASE_NOW_MS / 1000);

function createManagerWithFixedNow() {
  return new AuthManager({ now: () => BASE_NOW_MS });
}

function createManagerWithClock(startMs = BASE_NOW_MS) {
  let currentMs = startMs;
  const manager = new AuthManager({ now: () => currentMs });

  return {
    authManager: manager,
    advance(ms: number) {
      currentMs += ms;
    },
    get nowMs() {
      return currentMs;
    },
    get nowSec() {
      return Math.floor(currentMs / 1000);
    },
  };
}

describe('Auth (BaseAuth integration)', () => {
  describe('createCustomToken', () => {
    it('creates a custom token for a valid UID and claims', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const token = await auth.createCustomToken('valid-uid', {
        role: 'admin',
        featureFlags: { beta: true },
      });

      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('rejects invalid UIDs', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      await expect(auth.createCustomToken('')).rejects.toMatchObject({
        code: 'auth/invalid-uid',
      });
    });

    it('rejects non-object developer claims', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      await expect(
        auth.createCustomToken('uid', 'not-an-object' as unknown as object)
      ).rejects.toMatchObject({ code: 'auth/invalid-argument' });
    });

    it('propagates custom-claims validation errors', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      // `aud` is typically forbidden in custom claims
      await expect(
        auth.createCustomToken('uid', { aud: 'forbidden' })
      ).rejects.toMatchObject({
        code: 'auth/invalid-claims',
      });
    });
  });

  describe('verifyIdToken', () => {
    it('returns decoded token for a valid, unexpired token', async () => {
      const { authManager } = createManagerWithClock();
      const auth = authManager.auth;

      const payload: DecodedIdToken = {
        uid: 'user-1',
        exp: BASE_NOW_SEC + 60,
        iat: BASE_NOW_SEC,
        auth_time: BASE_NOW_SEC - 30,
      } as DecodedIdToken;

      const token = encodeIdToken(payload);
      const decoded = await auth.verifyIdToken(token);

      expect(decoded.uid).toBe('user-1');
      expect(decoded.exp).toBe(payload.exp);
      expect(decoded.iat).toBe(payload.iat);
    });

    it('rejects expired tokens with id-token-expired', async () => {
      const { authManager } = createManagerWithClock();
      const auth = authManager.auth;

      const payload: DecodedIdToken = {
        uid: 'user-1',
        exp: BASE_NOW_SEC - 10,
        iat: BASE_NOW_SEC - 20,
      } as DecodedIdToken;

      const token = encodeIdToken(payload);

      await expect(auth.verifyIdToken(token)).rejects.toMatchObject({
        code: 'auth/id-token-expired',
      });
    });

    it('rejects revoked tokens when checkRevoked is true', async () => {
      const clock = createManagerWithClock();
      const auth = clock.authManager.auth;
      const uid = 'revoked-user';

      await auth.createUser({ uid });

      // Token issued at "old" time
      const issuedAtSec = clock.nowSec;
      const payload: DecodedIdToken = {
        uid,
        exp: issuedAtSec + 3600,
        iat: issuedAtSec,
        auth_time: issuedAtSec,
      } as DecodedIdToken;
      const token = encodeIdToken(payload);

      // Advance clock, then revoke tokens; validSince > auth_time
      clock.advance(5 * 60 * 1000);
      await auth.revokeRefreshTokens(uid);

      await expect(auth.verifyIdToken(token, true)).rejects.toMatchObject({
        code: 'auth/id-token-revoked',
      });
    });

    it('rejects tokens for disabled users with user-disabled', async () => {
      const { authManager } = createManagerWithClock();
      const auth = authManager.auth;
      const uid = 'disabled-user';

      const user = await auth.createUser({ uid, disabled: true });

      const payload: DecodedIdToken = {
        uid: user.uid,
        exp: BASE_NOW_SEC + 3600,
        iat: BASE_NOW_SEC,
      } as DecodedIdToken;
      const token = encodeIdToken(payload);

      await expect(auth.verifyIdToken(token)).rejects.toMatchObject({
        code: 'auth/user-disabled',
      });
    });
  });

  describe('user CRUD and lookups', () => {
    it('supports createUser, getUser, updateUser, deleteUser', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const created = await auth.createUser({
        uid: 'u-crud',
        email: 'crud@example.com',
        phoneNumber: '+123456789',
      });

      const loaded = await auth.getUser(created.uid);
      expect(loaded.uid).toBe('u-crud');
      expect(loaded.email).toBe('crud@example.com');

      const updated = await auth.updateUser(created.uid, {
        email: 'updated@example.com',
      });

      expect(updated.email).toBe('updated@example.com');

      await auth.deleteUser(created.uid);

      await expect(auth.getUser(created.uid)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
    });

    it('supports getUserByEmail and getUserByPhoneNumber', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const email = 'lookup@example.com';
      const phoneNumber = '+19995550123';
      const uid = 'u-lookup';

      await auth.createUser({ uid, email, phoneNumber });

      const byEmail = await auth.getUserByEmail(email);
      expect(byEmail.uid).toBe(uid);

      const byPhone = await auth.getUserByPhoneNumber(phoneNumber);
      expect(byPhone.uid).toBe(uid);
    });

    it('supports getUsers with mixed identifiers', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const one = await auth.createUser({
        uid: 'u-multi-1',
        email: 'multi1@example.com',
      });
      const two = await auth.createUser({
        uid: 'u-multi-2',
        phoneNumber: '+19990000002',
      });

      const result = await auth.getUsers([
        { uid: one.uid },
        { email: one.email as string },
        { phoneNumber: two.phoneNumber as string },
        { uid: 'does-not-exist' },
      ]);

      expect(result.users.map((u) => u.uid).sort()).toEqual(
        ['u-multi-1', 'u-multi-2'].sort()
      );
      expect(result.notFound).toHaveLength(1);
      expect(result.notFound[0]).toMatchObject({ uid: 'does-not-exist' });
    });

    it('lists users with simple pagination', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      for (let i = 0; i < 5; i++) {
        await auth.createUser({ uid: `list-${i}` });
      }

      const firstPage = await auth.listUsers(2);
      expect(firstPage.users).toHaveLength(2);
      expect(firstPage.pageToken).toBeDefined();

      const secondPage = await auth.listUsers(2, firstPage.pageToken);
      expect(secondPage.users).toHaveLength(2);

      const thirdPage = await auth.listUsers(2, secondPage.pageToken);
      expect(thirdPage.users.length).toBeGreaterThanOrEqual(1);
    });

    it('deleteUsers aggregates successes and failures', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const u1 = await auth.createUser({ uid: 'batch-1' });
      const u2 = await auth.createUser({ uid: 'batch-2' });

      const result = await auth.deleteUsers([u1.uid, u2.uid, 'missing-user']);

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(2);
      expect(result.errors[0].error.code).toBe('auth/user-not-found');

      await expect(auth.getUser(u1.uid)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
    });
  });

  describe('custom claims and revocation', () => {
    it('setCustomUserClaims sets and clears claims', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const uid = 'claims-user';
      await auth.createUser({ uid });

      await auth.setCustomUserClaims(uid, { role: 'admin', beta: true });

      let user = await auth.getUser(uid);
      expect(user.customClaims).toMatchObject({ role: 'admin', beta: true });

      await auth.setCustomUserClaims(uid, null);

      user = await auth.getUser(uid);
      expect(user.customClaims).toBeUndefined();
    });

    it('revokeRefreshTokens updates tokensValidAfterTime for revocation checks', async () => {
      const clock = createManagerWithClock();
      const auth = clock.authManager.auth;
      const uid = 'revoke-user';

      await auth.createUser({ uid });

      // Before revocation, tokens should verify with checkRevoked
      const payload: DecodedIdToken = {
        uid,
        exp: clock.nowSec + 3600,
        iat: clock.nowSec,
        auth_time: clock.nowSec,
      } as DecodedIdToken;
      const token = encodeIdToken(payload);

      await expect(auth.verifyIdToken(token, true)).resolves.toMatchObject({
        uid,
      });

      // Advance clock and revoke
      clock.advance(60 * 1000);
      await auth.revokeRefreshTokens(uid);

      await expect(auth.verifyIdToken(token, true)).rejects.toMatchObject({
        code: 'auth/id-token-revoked',
      });
    });
  });

  describe('session cookies', () => {
    it('createSessionCookie wraps an ID token with a new exp', async () => {
      const clock = createManagerWithClock();
      const auth = clock.authManager.auth;

      const uid = 'cookie-user';
      await auth.createUser({ uid });

      const basePayload: DecodedIdToken = {
        uid,
        exp: clock.nowSec + 60,
        iat: clock.nowSec,
      } as DecodedIdToken;
      const idToken = encodeIdToken(basePayload);

      const expiresInMs = 2 * 60 * 60 * 1000; // 2 hours
      const cookie = await auth.createSessionCookie(idToken, {
        expiresIn: expiresInMs,
      });

      expect(typeof cookie).toBe('string');
      expect(cookie.split('.')).toHaveLength(3);

      const decoded = await auth.verifySessionCookie(cookie);
      // `verifySessionCookie` should see a future exp
      expect(decoded.uid).toBe(uid);
      expect(decoded.exp).toBeGreaterThan(clock.nowSec);
    });

    it('createSessionCookie rejects non-positive durations', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const payload: DecodedIdToken = {
        uid: 'cookie-user',
        exp: BASE_NOW_SEC + 60,
        iat: BASE_NOW_SEC,
      } as DecodedIdToken;
      const idToken = encodeIdToken(payload);

      await expect(
        auth.createSessionCookie(idToken, { expiresIn: 0 })
      ).rejects.toMatchObject({
        code: 'auth/invalid-session-cookie-duration',
      });
    });

    it('verifySessionCookie rejects expired cookies', async () => {
      const { authManager } = createManagerWithClock();
      const auth = authManager.auth;

      await auth.createUser({ uid: 'cookie-expired' });

      const payload: DecodedIdToken = {
        uid: 'cookie-expired',
        exp: BASE_NOW_SEC - 10,
        iat: BASE_NOW_SEC - 20,
      } as DecodedIdToken;
      const cookie = encodeIdToken(payload);

      await expect(auth.verifySessionCookie(cookie)).rejects.toMatchObject({
        code: 'auth/session-cookie-expired',
      });
    });

    it('verifySessionCookie rejects revoked cookies when checkRevoked is true', async () => {
      const clock = createManagerWithClock();
      const auth = clock.authManager.auth;

      const uid = 'cookie-revoked';
      await auth.createUser({ uid });

      const payload: DecodedIdToken = {
        uid,
        exp: clock.nowSec + 3600,
        iat: clock.nowSec,
        auth_time: clock.nowSec,
      } as DecodedIdToken;
      const idToken = encodeIdToken(payload);

      const cookie = await auth.createSessionCookie(idToken, {
        expiresIn: 3600 * 1000,
      });

      // Advance clock and revoke
      clock.advance(5 * 60 * 1000);
      await auth.revokeRefreshTokens(uid);

      await expect(
        auth.verifySessionCookie(cookie, true)
      ).rejects.toMatchObject({
        code: 'auth/session-cookie-revoked',
      });
    });
  });

  describe('provider configurations', () => {
    it('supports create, list, get, update, and delete provider configs', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const providerId = 'saml.mock-provider';

      const config = {
        providerId,
        displayName: 'My Provider',
        enabled: true,
      } as unknown as import('firebase-admin/auth').AuthProviderConfig;

      const created = await auth.createProviderConfig(config);
      expect(created.providerId).toBe(providerId);

      const list1 = await auth.listProviderConfigs({
        maxResults: 10,
        type: 'saml',
      });
      expect(list1.providerConfigs.length).toBe(1);

      const fetched = await auth.getProviderConfig(providerId);
      expect(fetched.providerId).toBe(providerId);
      expect(fetched.displayName).toBe('My Provider');

      const updated = await auth.updateProviderConfig(providerId, {
        displayName: 'Updated Provider',
      } as import('firebase-admin/auth').UpdateAuthProviderRequest);
      expect(updated.displayName).toBe('Updated Provider');
      expect(updated.providerId).toBe(providerId);

      await auth.deleteProviderConfig(providerId);

      await expect(auth.getProviderConfig(providerId)).rejects.toMatchObject({
        code: 'auth/invalid-provider-id',
      });
    });

    it('listProviderConfigs supports simple pagination', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      for (let i = 0; i < 3; i++) {
        await auth.createProviderConfig({
          providerId: `saml.provider-${i}`,
          displayName: `Provider ${i}`,
          enabled: true,
        } as unknown as import('firebase-admin/auth').AuthProviderConfig);
      }

      const page1 = await auth.listProviderConfigs({
        type: 'saml',
        maxResults: 2,
      });
      expect(page1.providerConfigs).toHaveLength(2);
      expect(page1.pageToken).toBeDefined();

      const page2 = await auth.listProviderConfigs({
        type: 'saml',
        maxResults: 2,
        pageToken: page1.pageToken,
      });
      expect(page2.providerConfigs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('auth-blocking tokens', () => {
    it('_verifyAuthBlockingToken decodes and normalizes the token', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      authManager.register('u1', {
        uid: 'auth-block',
        customClaims: {
          event_id: 'evt-123',
        },
      });
      const payload = buildAuthData(authManager.context({ key: 'u1' }))
        ?.token as DecodedIdToken;
      const token = encodeIdToken(payload);

      const decoded = await auth._verifyAuthBlockingToken(token);

      expect(decoded.uid).toBe('auth-block');
      expect(decoded.event_id).toBe('evt-123');
      // `applyToJSON` is invoked internally; basic shape is sufficient here.
    });
  });

  describe('tenant-aware Auth', () => {
    it('authManager.auth is an Auth instance and authForTenant returns TenantAwareAuth', () => {
      const authManager = createManagerWithFixedNow();
      const projectAuth = authManager.auth;

      expect(projectAuth).toBeInstanceOf(Auth);

      const tenantAuth = projectAuth.authForTenant('tenant-1');
      expect(tenantAuth).toBeInstanceOf(TenantAwareAuth);
      expect(tenantAuth.tenantId).toBe('tenant-1');
    });

    it('scopes users to their tenant', async () => {
      const authManager = createManagerWithFixedNow();
      const projectAuth = authManager.auth;

      const tenantOne = projectAuth.authForTenant('tenant-one');
      const tenantTwo = projectAuth.authForTenant('tenant-two');

      const u1 = await tenantOne.createUser({
        uid: 'tenant-1-user',
        email: 'tenant1@example.com',
      });
      const u2 = await tenantTwo.createUser({
        uid: 'tenant-2-user',
        email: 'tenant2@example.com',
      });

      // Tenant-specific lookups succeed
      const t1Loaded = await tenantOne.getUser(u1.uid);
      expect(t1Loaded.email).toBe('tenant1@example.com');

      const t2Loaded = await tenantTwo.getUser(u2.uid);
      expect(t2Loaded.email).toBe('tenant2@example.com');

      // Cross-tenant lookups fail
      await expect(tenantOne.getUser(u2.uid)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
      await expect(tenantTwo.getUser(u1.uid)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });

      // Project-wide auth does not see tenant-scoped users
      await expect(projectAuth.getUser(u1.uid)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
      await expect(projectAuth.getUser(u2.uid)).rejects.toMatchObject({
        code: 'auth/user-not-found',
      });
    });
  });

  describe('action links', () => {
    it('generates deterministic password reset links (project-wide)', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const url = await auth.generatePasswordResetLink('alice@example.com');

      expect(url.startsWith('https://mock.reset.local/')).toBe(true);
      expect(url).toContain('mode=resetPassword');
      expect(url).toContain('email=alice%40example.com');
      // Project-wide auth should not include a tenant parameter
      expect(url).not.toContain('tenant=');
    });

    it('includes tenant in links generated by TenantAwareAuth', async () => {
      const authManager = createManagerWithFixedNow();
      const tenantId = 'tenant-actions';
      const tenantAuth = authManager.auth.authForTenant(tenantId);

      const url = await tenantAuth.generatePasswordResetLink('bob@example.com');

      expect(url.startsWith('https://mock.reset.local/')).toBe(true);
      expect(url).toContain(`tenant=${encodeURIComponent(tenantId)}`);
      expect(url).toContain('mode=resetPassword');
      expect(url).toContain('email=bob%40example.com');
    });
  });

  describe('importUsers', () => {
    it('imports users and reports success counts', async () => {
      const authManager = createManagerWithFixedNow();
      const auth = authManager.auth;

      const result = await auth.importUsers([
        {
          uid: 'import-1',
          email: 'import1@example.com',
        },
        {
          uid: 'import-2',
        },
      ]);

      expect(result.successCount).toBe(2);
      expect(result.failureCount).toBe(0);

      const u1 = await auth.getUser('import-1');
      const u2 = await auth.getUser('import-2');

      expect(u1.email).toBe('import1@example.com');
      expect(u2.uid).toBe('import-2');
    });
  });
});
