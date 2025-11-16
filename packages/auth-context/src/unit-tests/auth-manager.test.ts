import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { AuthManager } from '../lib/auth-manager.js';
import { MockIdentity, SignInProvider, UserConstructor } from '../lib/types.js';

describe('AuthManager (general features)', () => {
  const FIXED_MS = Date.UTC(2025, 0, 2, 3, 4, 5, 678); // 2025-01-02T03:04:05.678Z
  const FIXED_SEC = Math.floor(FIXED_MS / 1000);
  const M30 = 30 * 60;
  const H1 = 60 * 60;

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
      providers: SignInProvider.Google,
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
    expect(() => mgr.identity('alice')).toThrow(/not registered/i);
  });

  test('context(): default timing and app-check presence', () => {
    const mgr = new AuthManager({
      now: () => FIXED_MS,
      projectNumber: '555000111',
      projectId: 'proj-ctx',
      appId: '1:555000111:web:abc123',
    });
    mgr.register('bob', {
      email: 'bob@example.com',
      providers: SignInProvider.Google,
    });

    const ctx = mgr.context({ key: 'bob' });
    expect(ctx.iat).toBe(FIXED_SEC);
    expect(ctx.auth_time).toBe(FIXED_SEC - M30);
    expect(ctx.exp).toBe(FIXED_SEC + M30);

    // Identity present
    expect(ctx.identity?.uid).toBeTruthy();
    expect(ctx.identity?.iss).toBe(mgr.iss);
    expect(ctx.identity?.email).toBe('bob@example.com');
    expect(ctx.identity?.firebase.sign_in_provider).toBe('google.com');

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

    const ctx = mgr.context({ key: 'noapp', appCheck: false });
    expect(ctx.app).toBeUndefined();
  });

  test('context(): timing overrides are respected', () => {
    const mgr = new AuthManager({ now: () => FIXED_MS });
    mgr.register('timed', { email: 't@example.com' });

    const customIat = FIXED_SEC + 10;
    const customAuthTime = customIat - 60;
    const customExp = customIat + 90;

    const ctx = mgr.context({
      key: 'timed',
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
    const ctx = mgr.context({
      key: 'seed',
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
    mgr.register('g', {
      email: 'g@example.com',
      providers: SignInProvider.Google.override({ email: 'g@example.com' }),
    });
    const g = mgr.identity('g') as MockIdentity;
    expect(g.firebase.sign_in_provider).toBe('google.com');
    expect(g.firebase.identities['google.com']?.length).toBe(1);
    expect(g.firebase.identities.email?.[0]).toBe('g@example.com');

    // password keeps 'password' and includes email identity
    mgr.register('p', {
      email: 'p@example.com',
      providers: SignInProvider.Password.override({ email: 'p@example.com' }),
    });
    const p = mgr.identity('p');
    expect(p.firebase.sign_in_provider).toBe('password');
    expect(p.firebase.identities.email?.[0]).toBe('p@example.com');

    // anonymous keeps 'anonymous' and typically no identities bucket
    mgr.register('a', { providers: SignInProvider.anonymous() });
    const a = mgr.identity('a');
    expect(a.firebase.sign_in_provider).toBe('anonymous');
    expect(a.firebase.identities ?? {}).toEqual({});
  });

  test('context(): throws for unknown keys', () => {
    const mgr = new AuthManager();
    expect(() => mgr.context({ key: 'missing' })).toThrow(/not registered/i);
  });

  it('Defaults user info to that of the first sign-in provider', () => {
    const GoogleProvider = SignInProvider.Google.override({
      email: 'jonathan-smith@gmail.com',
      displayName: 'Jon Smith',
      phoneNumber: '+15551234567',
      photoURL: 'https://drive.google.com/image1.png',
    });
    const MicrosoftProvider = SignInProvider.Microsoft.override({
      email: 'jonathan-smith@outlook.com',
      displayName: 'Jonathan Smith',
      phoneNumber: '+15557654321',
      photoURL: 'https://onedrive.com/image1.png',
    });
    const manager = new AuthManager();
    manager.register('u1', {
      providers: [GoogleProvider, MicrosoftProvider],
      multiFactorEnrollments: [{ factorId: 'phone' }, { factorId: 'totp' }],
      multiFactorDefault: 'phone',
    });

    manager.register('u2', {
      providers: [MicrosoftProvider, GoogleProvider],
      multiFactorEnrollments: [{ factorId: 'phone' }, { factorId: 'totp' }],
      multiFactorDefault: 'phone',
    });
    const gIdentity = manager.identity('u1');
    const msIdentity = manager.identity('u2');

    function expectUserInfo(id: MockIdentity, provider: SignInProvider): void {
      expect(provider.data).toBeDefined();
      const data = provider.data as UserConstructor;
      expect(id.name).toBe(data.displayName);
      expect(id.email).toBe(data.email);
      expect(id.phone_number).toBe(data.phoneNumber);
      expect(id.photo_url).toBe(data.photoURL);
    }

    expectUserInfo(gIdentity, GoogleProvider);
    expectUserInfo(msIdentity, MicrosoftProvider);
  });

  it('Correctly resolves MFA defaults and overrides', () => {
    const manager = new AuthManager();
    manager.register('u1', {
      providers: SignInProvider.Google,
      multiFactorEnrollments: [{ factorId: 'phone' }, { factorId: 'totp' }],
      multiFactorDefault: 'totp',
    });
    manager.register('u2', {
      providers: SignInProvider.Google,
      multiFactorEnrollments: [{ factorId: 'totp' }, { factorId: 'phone' }],
      multiFactorDefault: 'phone',
    });

    const id1 = manager.identity('u1');
    expect(id1.firebase.sign_in_second_factor).toBe('totp');
    expect(id1.firebase.second_factor_identifier).toBeDefined();
    const id2 = manager.identity('u2');
    expect(id2.firebase.sign_in_second_factor).toBe('phone');
    expect(id2.firebase.second_factor_identifier).toBeDefined();
    const id3 = manager.identity('u1', { multifactorSelector: 'phone' });
    expect(id3.firebase.sign_in_second_factor).toBe('phone');
    expect(id3.firebase.second_factor_identifier).toBeDefined();
    const id4 = manager.identity('u2', { multifactorSelector: 'totp' });
    expect(id4.firebase.sign_in_second_factor).toBe('totp');
    expect(id4.firebase.second_factor_identifier).toBeDefined();
  });

  test('constructs anonymous tokens', () => {
    const mgr = new AuthManager();
    mgr.register('anon', {
      providers: SignInProvider.anonymous(),
    });
    const id = mgr.identity('anon');
    expect(id.firebase.sign_in_provider).toBe('anonymous');
    expect(id.firebase.identities).toEqual({});
  });

  it('Ignores MFA for anonymous tokens', () => {
    const manager = new AuthManager();
    manager.register('u1', {
      providers: SignInProvider.anonymous(),
      multiFactorEnrollments: [{ factorId: 'phone' }, { factorId: 'totp' }],
      multiFactorDefault: 'totp',
    });

    const id1 = manager.identity('u1');
    expect(id1.firebase.sign_in_provider).toBe('anonymous');
    expect(id1.firebase.sign_in_second_factor).toBeUndefined();
    expect(id1.firebase.second_factor_identifier).toBeUndefined();
    const id2 = manager.identity('u1', { multifactorSelector: 'phone' });
    expect(id2.firebase.sign_in_provider).toBe('anonymous');
    expect(id2.firebase.sign_in_second_factor).toBeUndefined();
    expect(id2.firebase.second_factor_identifier).toBeUndefined();
  });

  it('Ignores identity fields for anonymous tokens', () => {
    const manager = new AuthManager();
    manager.register('u1', {
      providers: SignInProvider.anonymous(),
      phoneNumber: '+5551234567',
      email: 'user@example.com',
      emailVerified: true,
    });

    const id1 = manager.identity('u1');
    expect(id1.firebase.sign_in_provider).toBe('anonymous');
    expect(id1.email).toBeUndefined();
    expect(id1.email_verified).toBeUndefined();
    expect(id1.phone_number).toBeUndefined();
  });

  it('Allows custom claims for anonymous tokens', () => {
    const manager = new AuthManager();
    manager.register('u1', {
      providers: SignInProvider.anonymous(),
      customClaims: {
        custom_claim_string: 'test',
        custom_claim_number: 123,
        custom_claim_boolean: true,
      },
    });

    const id1 = manager.identity('u1');
    expect(id1['custom_claim_string']).toBe('test');
    expect(id1['custom_claim_number']).toBe(123);
    expect(id1['custom_claim_boolean']).toBe(true);
  });

  it('Allows non-identifying standard claims for anonymous tokens', () => {
    const manager = new AuthManager();
    manager.register('u1', {
      providers: SignInProvider.anonymous(),
      displayName: 'User One',
      photoURL: 'https://photos.com/photo.png',
      tenantId: 't12345',
    });

    const id1 = manager.identity('u1');
    expect(id1.name).toBe('User One');
    expect(id1.photo_url).toBe('https://photos.com/photo.png');
    expect(id1.firebase.tenant).toBe('t12345');
  });
});
