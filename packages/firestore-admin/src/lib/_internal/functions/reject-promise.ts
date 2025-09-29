/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Returns a `Promise` that rejects asynchronously using `queueMicrotask`.
 */
export function rejectPromise<T>(reason: any): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    queueMicrotask(() => reject(reason));
  });
}
