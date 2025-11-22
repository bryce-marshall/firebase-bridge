import { ServiceMap, ServiceRegistry, ServiceStore } from "./service-registry";

// single instance for this module
const registry: ServiceStore<ServiceMap> =
  new ServiceRegistry<ServiceMap>();

export function serviceRegistry<
  TServices extends ServiceMap = ServiceMap
>(): ServiceStore<TServices> {
  return registry as ServiceStore<TServices>;
}

export function registerServices<TServices extends ServiceMap>(
  services: Partial<TServices>
): void {
  for (const [key, value] of Object.entries(services)) {
    if (key && value) {
      (registry as ServiceRegistry<TServices>).set(
        key as keyof TServices,
        value
      );
    }
  }
}

export function resetServices(): void {
  (registry as ServiceRegistry<ServiceMap>).reset();
}
