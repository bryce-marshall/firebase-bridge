import { AuthManager } from '../lib/auth-manager';
import { SignInProvider } from '../lib/types';

describe('AuthManager (general features)', () => {
  it('Should get UserRecord', async () => {
    const auth = new AuthManager();
    const uid = auth.register('u1', {
      providers: SignInProvider.Google,
    });

    const ur = await auth.auth.getUser(uid);
    console.log('UserRecord', JSON.stringify(ur, undefined, 3));
  });
});
