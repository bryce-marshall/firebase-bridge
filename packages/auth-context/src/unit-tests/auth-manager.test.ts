import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { AuthManager } from '../lib/auth-manager.js';
import { MockIdentity } from '../lib/types.js';

describe('AuthManager (general features)', () => {
  const FIXED_MS = Date.UTC(2025, 0, 2, 3, 4, 5, 678); // 2025-01-02T03:04:05.678Z
  const FIXED_SEC = Math.floor(FIXED_MS / 1000);
  const M30 = 30 * 60;
  const H1 = 60 * 60;

  test('constructs anonymous identity', () => {
    const mgr = new AuthManager();
    mgr.register('anon', {
      signInProvider: 'anonymous',
    });
  });

  test('constructs with explicit overrides and exposes derived fields', () => {
    const mgr = new AuthManager({
      now: () => FIXED_MS,
      projectNumber: '1234567890',
      projectId: 'demo-project',
      region: 'australia-southeast1',
      appId: '1:1234567890:web:deadbeefcafebabeface00',
    });

    // Basic identity of manager
    expect(mgr.projectNumber).toBe('1234567890');
    expect(mgr.projectId).toBe('demo-project');
    expect(mgr.region).toBe('australia-southeast1');
    expect(mgr.appId).toBe('1:1234567890:web:deadbeefcafebabeface00');

    // Issuer is a URL-like string; App Check tokens produced should reuse it.
    expect(typeof mgr.iss).toBe('string');
    expect(mgr.iss.startsWith('https://firebaseappcheck.googleapis.com/')).toBe(
      true
    );

    // Sanity check the bound broker is present (actual broker tests are elsewhere).
    expect(mgr.https).toBeTruthy();
  });

  test('registry: register / identity deep-clone / deregister', () => {
    const mgr = new AuthManager({ now: () => FIXED_MS });
    mgr.register('alice', {
      email: 'alice@example.com',
      signInProvider: 'google',
    });

    // Identity is returned as a deep clone (mutating it should not change stored template)
    const read1 = mgr.identity('alice') as MockIdentity;
    expect(read1).toBeTruthy();
    const originalProvider = read1.firebase.sign_in_provider;
    expect(originalProvider).toBe('google.com'); // normalized

    // Mutate the returned clone
    read1.firebase.sign_in_provider = 'twitter.com';
    read1.email = 'mutated@example.com';

    // Re-read should show original, unaffected
    const read2 = mgr.identity('alice') as MockIdentity;
    expect(read2.firebase.sign_in_provider).toBe('google.com');
    expect(read2.email).toBe('alice@example.com');

    // Duplicate registration should throw
    expect(() =>
      mgr.register('alice', { email: 'alice2@example.com' })
    ).toThrow(/already registered/i);

    // Deregister returns true only when it existed
    expect(mgr.deregister('alice')).toBe(true);
    expect(mgr.deregister('alice')).toBe(false);
    expect(mgr.identity('alice')).toBeUndefined();
  });

  test('context(): default timing and app-check presence', () => {
    const mgr = new AuthManager({
      now: () => FIXED_MS,
      projectNumber: '555000111',
      projectId: 'proj-ctx',
      appId: '1:555000111:web:abc123',
    });
    mgr.register('bob', { email: 'bob@example.com', signInProvider: 'google' });

    const ctx = mgr.context('bob');
    expect(ctx.iat).toBe(FIXED_SEC);
    expect(ctx.auth_time).toBe(FIXED_SEC - M30);
    expect(ctx.exp).toBe(FIXED_SEC + M30);

    // Identity present
    expect(ctx.identity.uid).toBeTruthy();
    expect(ctx.identity.iss).toBe(mgr.iss);
    expect(ctx.identity.email).toBe('bob@example.com');
    expect(ctx.identity.firebase.sign_in_provider).toBe('google.com');

    // App Check present by default
    expect(ctx.app).toBeTruthy();
    expect(ctx.app?.appId).toBe('1:555000111:web:abc123');

    const tok = ctx.app?.token as DecodedAppCheckToken;
    expect(tok.sub).toBe('1:555000111:web:abc123');
    expect(tok.app_id).toBe('1:555000111:web:abc123');
    expect(tok.aud).toEqual(['555000111', 'proj-ctx']);
    expect(tok.iss).toBe(mgr.iss);
    expect(tok.iat).toBe(FIXED_SEC);
    expect(tok.exp).toBe(FIXED_SEC + H1);
    expect(tok.exp - tok.iat).toBe(H1);
  });

  test('context(): supports suppressing app-check', () => {
    const mgr = new AuthManager({ now: () => FIXED_MS });
    mgr.register('noapp', { email: 'noapp@example.com' });

    const ctx = mgr.context('noapp', { appCheck: false });
    expect(ctx.app).toBeUndefined();
  });

  test('context(): timing overrides are respected', () => {
    const mgr = new AuthManager({ now: () => FIXED_MS });
    mgr.register('timed', { email: 't@example.com' });

    const customIat = FIXED_SEC + 10;
    const customAuthTime = customIat - 60;
    const customExp = customIat + 90;

    const ctx = mgr.context('timed', {
      iat: customIat,
      authTime: customAuthTime,
      expires: customExp,
    });

    expect(ctx.iat).toBe(customIat);
    expect(ctx.auth_time).toBe(customAuthTime);
    expect(ctx.exp).toBe(customExp);
  });

  test('appCheck(): respects provided iat/exp and carries custom claims', () => {
    const mgr = new AuthManager({
      now: () => FIXED_MS,
      projectNumber: '999',
      projectId: 'apx',
      appId: '1:999:web:xyz',
    });

    // Expose appCheck via the public context hook (no identity required to call appCheck directly here)
    // We’ll use context() just to get a valid construction path with token overrides.
    mgr.register('seed', {});
    const ctx = mgr.context('seed', {
      appCheck: {
        // seed fields we expect to be preserved *in addition* to normalized claims
        foo: 'bar',
        iat: FIXED_SEC - 5,
        exp: FIXED_SEC + 5,
      },
    });

    const tok = ctx.app?.token as DecodedAppCheckToken;
    expect(tok.foo).toBe('bar');
    expect(tok.iat).toBe(FIXED_SEC - 5);
    expect(tok.exp).toBe(FIXED_SEC + 5);

    // Normalized fields still applied
    expect(tok.sub).toBe('1:999:web:xyz');
    expect(tok.app_id).toBe('1:999:web:xyz');
    expect(tok.aud).toEqual(['999', 'apx']);
    expect(tok.iss).toBe(mgr.iss);
  });

  test('provider normalization & identities: google/email/password/anonymous', () => {
    const mgr = new AuthManager({ now: () => FIXED_MS });

    // google → google.com + identities bucket
    mgr.register('g', { email: 'g@example.com', signInProvider: 'google' });
    const g = mgr.identity('g') as MockIdentity;
    expect(g.firebase.sign_in_provider).toBe('google.com');
    expect(g.firebase.identities['google.com']?.length).toBe(1);
    expect(g.firebase.identities.email?.[0]).toBe('g@example.com');

    // password keeps 'password' and includes email identity
    mgr.register('p', { email: 'p@example.com', signInProvider: 'password' });
    const p = mgr.identity('p') as MockIdentity;
    expect(p.firebase.sign_in_provider).toBe('password');
    expect(p.firebase.identities.email?.[0]).toBe('p@example.com');

    // anonymous keeps 'anonymous' and typically no identities bucket
    mgr.register('a', { signInProvider: 'anonymous' });
    const a = mgr.identity('a') as MockIdentity;
    expect(a.firebase.sign_in_provider).toBe('anonymous');
    expect(a.firebase.identities ?? {}).toEqual({});
  });

  test('oauthIds seeding: fixed IDs for specified providers, generated for others', () => {
    const mgr = new AuthManager({
      now: () => FIXED_MS,
      oauthIds: {
        'google.com': 'CONST_GOOGLE_UID',
        'apple.com': undefined, // explicit: still forces generation (non-empty)
      },
    });

    mgr.register('g', { signInProvider: 'google' });
    mgr.register('a', { signInProvider: 'apple' });
    mgr.register('t', { signInProvider: 'twitter' });
    mgr.register('g2', { signInProvider: 'google' });
    mgr.register('a2', { signInProvider: 'apple' });
    mgr.register('t2', { signInProvider: 'twitter' });

    const g = mgr.identity('g') as MockIdentity;
    const a = mgr.identity('a') as MockIdentity;
    const t = mgr.identity('t') as MockIdentity;

    expect(g.firebase.sign_in_provider).toBe('google.com');

    // For apple & twitter we only assert "truthy" stable values (exact value is generated)
    const googleId = firebasePid('google.com', g);
    const appleId = firebasePid('apple.com', a);
    const twId = firebasePid('twitter.com', t);

    expect(googleId).toBe('CONST_GOOGLE_UID');
    expect(typeof appleId).toBe('string');
    expect(appleId).toBeTruthy();

    expect(typeof twId).toBe('string');
    expect(twId).toBeTruthy();

    // Identities with common oauth-registered providers should have consistent ids,
    // others should not despite having the same provider.
    const g2 = mgr.identity('g2') as MockIdentity;
    const a2 = mgr.identity('a2') as MockIdentity;
    const t2 = mgr.identity('t2') as MockIdentity;
    const googleId2 = firebasePid('google.com', g2);
    const appleId2 = firebasePid('apple.com', a2);
    const twId2 = firebasePid('twitter.com', t2);
    expect(googleId).toBe(googleId2);
    expect(appleId).toBe(appleId2);
    expect(twId).not.toBe(twId2);
  });

  test('context(): throws for unknown keys', () => {
    const mgr = new AuthManager();
    expect(() => mgr.context('missing')).toThrow(/no identity registered/i);
  });
});

function firebasePid(provider: string, id: MockIdentity): string {
  return id.firebase.identities[provider]?.[0];
}
