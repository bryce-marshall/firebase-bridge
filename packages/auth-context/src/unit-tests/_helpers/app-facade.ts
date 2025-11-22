import { Auth } from 'firebase-admin/auth';
import { serviceRegistry } from './app-env';
import { ServiceStore } from './service-registry';

export interface TimeService {
  now: () => Date;
  millisNow: () => number;
}
/**
 * The set of base services require by the platform.
 */
export interface PlatformServiceMap {
  readonly auth: Auth;
  readonly time: TimeService;
}
/**
 * The facade used by backend Firebase code (Https cloud functions, Firestore triggers, etc).
 * Extend as required.
 */
export class AppFacade {
  private readonly _services: ServiceStore<PlatformServiceMap>;

  static readonly singleton = new AppFacade();

  private constructor() {
    this._services = serviceRegistry<PlatformServiceMap>();
  }

  get auth(): Auth {
    return this._services.get('auth');
  }

  get time(): TimeService {
    return this._services.get('time');
  }
}
