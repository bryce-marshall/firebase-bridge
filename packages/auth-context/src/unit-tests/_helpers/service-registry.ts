// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ServiceMap = Record<string, any>;

export interface ServiceStore<TServices extends ServiceMap> {
  get<K extends keyof TServices>(key: K): TServices[K];
  optional<K extends keyof TServices>(key: K): TServices[K] | undefined;
}

export class ServiceRegistry<TServices extends ServiceMap>
  implements ServiceStore<TServices>
{
  private readonly store = new Map<
    keyof TServices,
    TServices[keyof TServices]
  >();

  set<K extends keyof TServices>(key: K, value: TServices[K]): void {
    this.store.set(key, value);
  }

  get<K extends keyof TServices>(key: K): TServices[K] {
    if (!this.store.has(key)) {
      throw new Error(`Service "${String(key)}" has not been registered.`);
    }
    return this.store.get(key) as TServices[K];
  }

  optional<K extends keyof TServices>(key: K): TServices[K] | undefined {
    return this.store.get(key) as TServices[K];
  }

  reset(): void {
    this.store.clear();
  }
}

