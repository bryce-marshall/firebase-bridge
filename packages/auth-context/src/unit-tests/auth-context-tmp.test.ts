import { AuthManager } from '../lib/auth-manager.js';
import { AltKey, SignInProvider } from '../lib/types.js';

describe('AuthManager (general features)', () => {
  const auth = new AuthManager({
    projectId: 'demo',
    region: 'us-central1',
  });

  afterEach(() => {
    auth.clear();
  });

  it('minimal identity creation', () => {
    auth.register('alice', {
      providers: SignInProvider.Google,
    });

    const token = auth.token({ key: 'alice' });
    console.log(
      'minimal identity creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('enhanced identity creation', () => {
    auth.register('alice', {
      providers: SignInProvider.Google.override({
        phoneNumber: '+5551234567',
      }),
      displayName: 'alice',
      email: 'alice@example.com',
      multiFactorEnrollments: { factorId: 'phone' },
      multiFactorDefault: 'phone',
      customClaims: {
        user_roles: ['premium-features'],
      },
      photoURL: 'https://photos.example.com/alice/image1.png',
    });

    const token = auth.token({ key: 'alice' });
    console.log(
      'enhanced identity creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('multiple identity creation', () => {
    auth.register('alice', {
      providers: [
        SignInProvider.Google.override({ email: 'alice12345@gmail.com' }),
        SignInProvider.Microsoft.override({
          displayName: 'alice',
          email: 'alice12345@outlook.com',
        }),
        SignInProvider.Apple.override({
          email: 'alice12345@gmail.com',
          photoURL: 'https://photos.example.com/alice/image1.png',
        }),
      ],
    });

    const token = auth.token({
      key: 'alice',
      signInProvider: SignInProvider.Apple.signInProvider,
    });
    console.log(
      'multiple identity creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('suppress provider defaults identity creation', () => {
    auth.register('alice', {
      providers: SignInProvider.Google.override({
        email: 'alice@example.com',
        phoneNumber: '+5551234567',
        displayName: 'alice',
        photoURL: 'https://photos.example.com/alice/image1.png',
      }),
      suppressProviderDefaults: true,
    });

    const token = auth.token({ key: 'alice' });
    console.log(
      'suppress provider defaults token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('provider default overrides identity creation', () => {
    auth.register('alice', {
      providers: SignInProvider.Google.override({
        email: 'alice@example.com',
        phoneNumber: '+5551234567',
        displayName: 'alice',
        photoURL: 'https://photos.example.com/alice/image1.png',
      }),
      email: 'alice2@example.com',
      phoneNumber: '+5557654321',
      displayName: 'Miss Alice',
      photoURL: 'https://photos.example.com/alice/image2.png',
    });

    const token = auth.token({ key: 'alice' });
    console.log(
      'provider default overrides token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('tenanted identity registration', () => {
    auth.register('alice', {
      providers: SignInProvider.Google,
      tenantId: 'tenant-one',
    });

    const token = auth.token({ key: 'alice' });
    console.log(
      'tenanted identity registration token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('tenanted identity api creation', async () => {
    const tenant = auth.auth.tenantManager().authForTenant('tenant-two');
    const user = await tenant.createUser({
      displayName: 'Bob',
      email: 'bob@example.com',
      emailVerified: true,
    });

    await tenant.updateUser(user.uid, {
      providerToLink: {
        providerId: 'google.com',
        uid: '123456789',
        email: 'bob@example.com',
      },
    });

    const token = auth.token({
      key: AltKey.email('bob@example.com', 'tenant-two'),
    });
    console.log(
      'tenanted identity api creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('custom identity creation', () => {
    auth.register('alice', {
      providers: SignInProvider.custom('my-custom-provider', {
        email: 'alice@example.com',
      }),
    });

    const token = auth.token({ key: 'alice' });
    console.log(
      'custom identity creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('anonymous identity creation', () => {
    auth.register('anon', {
      providers: SignInProvider.anonymous(),
    });

    const token = auth.token({ key: 'anon' });
    console.log(
      'anonymous identity creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });

  it('default anonymous identity creation', () => {
    auth.register('default-anon');

    const token = auth.token({ key: 'default-anon' });
    console.log(
      'default anonymous identity creation token:',
      JSON.stringify(token, undefined, 3)
    );
  });
});
