/**
 * The minimum latency to apply. Note that `queueMicrotask()` does not guarantee sufficient
 * latency to recreate certain transactional conflicts that might otherwise occur in the
 * production/emulator Firestore environments.
 */
const MIN_LATENCY = 3;

/**
 * Returns a `Promise` that resolves asynchronously with latency.
 */
export function resolvePromise(): Promise<void>;
/**
 * Returns a `Promise` that resolves `value` asynchronously with latency.
 */
export function resolvePromise<T>(value: T, delay?: number): Promise<T>;
export function resolvePromise(
  value?: unknown,
  delay?: number
): Promise<unknown> {
  delay = Math.max(delay ?? MIN_LATENCY, MIN_LATENCY);
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), delay);
  });
}
