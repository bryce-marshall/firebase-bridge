import { AuthManager, AuthManagerOptions } from '../../lib/auth-manager';
import { SignInProvider } from '../../lib/types';
import { registerServices, resetServices } from './app-env';
import { PlatformServiceMap, TimeService } from './app-facade';

export enum TestIdentity {
  Admin = 'yxibjAcGxQONN2KLgFIpl9PJCHVI',
  Jane = '5ulbDn0vGO4WNTqocKA0a2qfBR92',
  John = 'B8jgXJrfVyA2vQVMSVPLoAVx9Y0K',
}

export class TestTimeService implements TimeService {
  private _fn: (() => Date) | undefined;

  now(): Date {
    return this._fn?.() ?? new Date();
  }

  millisNow(): number {
    return this.now().valueOf();
  }

  set(fn?: () => Date) {
    this._fn = fn;
  }
}

export type TestManagerOptions = Omit<AuthManagerOptions, 'now'>;

export class TestAuthManager extends AuthManager<TestIdentity> {
  readonly Tenants = Object.freeze({
    TenantOne: 'tenant-one',
  });

  readonly time = new TestTimeService();

  constructor(options?: TestManagerOptions) {
    super({ ...options, now: () => this.time.now().valueOf() });
    this.clear();
    resetServices();
    registerServices<PlatformServiceMap>({
      time: this.time,
      auth: this.auth,
    });
  }

  override reset(): void {
    this.time.set();
    super.reset();
  }

  override clear(): void {
    super.clear();

    this.register(TestIdentity.Admin, {
      uid: TestIdentity.Admin,
      providers: SignInProvider.Google.override({ email: 'admin@email.com' }),
    });
    this.register(TestIdentity.Jane, {
      uid: TestIdentity.Jane,
      providers: SignInProvider.Google.override({ email: 'jane@email.com' }),
      tenantId: this.Tenants.TenantOne,
    });
    this.register(TestIdentity.John, {
      uid: TestIdentity.John,
      providers: SignInProvider.Google.override({ email: 'john@email.com' }),
      tenantId: this.Tenants.TenantOne,
    });
  }
}
