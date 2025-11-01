import { AuthManager, AuthManagerOptions } from '../../lib/auth-manager';

export enum TestIdentity {
  Admin = 'yxibjAcGxQONN2KLgFIpl9PJCHVI',
  Jane = '5ulbDn0vGO4WNTqocKA0a2qfBR92',
  John = 'B8jgXJrfVyA2vQVMSVPLoAVx9Y0K',
}

export class TestManager extends AuthManager<TestIdentity> {
  constructor(options?: AuthManagerOptions) {
    super(options);
    this.register(TestIdentity.Admin, {
      email: 'admin@email.com',
      email_verified: true,
      uid: TestIdentity.Admin,
      signInProvider: 'google',
    });
    this.register(TestIdentity.Jane, {
      email: 'jane@email.com',
      email_verified: true,
      uid: TestIdentity.Jane,
      signInProvider: 'google',
    });
    this.register(TestIdentity.John, {
      email: 'john@email.com',
      email_verified: true,
      uid: TestIdentity.John,
      signInProvider: 'google',
    });
  }
}
