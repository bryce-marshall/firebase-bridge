import { AppFacade } from './_helpers/app-facade.js';
import { TestAuthManager, TestIdentity } from './_helpers/test-auth-manager.js';

describe('AppFacade examples', () => {
  const auth = new TestAuthManager({
    projectId: 'demo',
    region: 'us-central1',
  });

  afterEach(() => {
    auth.reset();
  });

  it('Provides the injected auth api', async () => {
    const tenant = AppFacade.singleton.auth
      .tenantManager()
      .authForTenant('tenant-one');
    const user = await tenant.getUser(TestIdentity.Jane);
    expect(user).toBeDefined();
    expect(user.uid).toBe(TestIdentity.Jane);
  });

  it('Provides the injected Time service', async () => {
    auth.time.set(() => new Date(2011, 11, 11, 11, 11, 11, 11));

    const now = AppFacade.singleton.time.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getFullYear()).toBe(2011);
    expect(now.getMonth()).toBe(11);
    expect(now.getDate()).toBe(11);
    expect(now.getHours()).toBe(11);
    expect(now.getMinutes()).toBe(11);
    expect(now.getSeconds()).toBe(11);
    expect(now.getMilliseconds()).toBe(11);
  });
});
