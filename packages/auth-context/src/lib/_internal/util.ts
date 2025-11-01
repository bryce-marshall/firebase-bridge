export type JustCallable<T> = T extends { (...args: infer A): infer R }
  ? (...args: A) => R
  : never;

/**
 * Normalize a possibly-sync function into a Promise.
 *
 * @typeParam T - The return type of the executor.
 *
 * @param executor - A function that may return `T` or `Promise<T>`, and may throw.
 * @returns A `Promise<T>` that resolves/rejects to the executor's outcome.
 *
 * @remarks
 * - Synchronously thrown errors are converted into a rejected Promise.
 * - Already-Promise returns are awaited via `Promise.resolve(...)`.
 *
 * @example
 * ```ts
 * await execPromise(() => 42);          // resolves 42
 * await execPromise(async () => 42);    // resolves 42
 * await execPromise(() => { throw e }); // rejects with e
 * ```
 */
export function execPromise<T>(executor: () => T | Promise<T>): Promise<T> {
  let result: Promise<T>;
  try {
    result = Promise.resolve(executor());
  } catch (reason) {
    result = Promise.reject(reason);
  }

  return result;
}

/**
 * Deeply clone simple JSON-like values with special handling for `Date`.
 *
 * @typeParam T - Value type.
 *
 * @param v - The value to clone.
 * @returns A deep copy of `v` for supported shapes; otherwise returns `v` as-is.
 *
 * @remarks
 * - Clones:
 *   - `null`/`undefined` → returned as-is.
 *   - `Date` → new `Date(valueOf)`.
 *   - Arrays → element-wise deep clone.
 *   - Plain objects (prototype exactly `Object.prototype`) → property-wise deep clone.
 * - Non-plain objects (e.g., classes, Maps, Sets, RegExps, Buffers) are **returned as-is**.
 * - Functions and accessors are not copied.
 * - This is not a general-purpose deep clone; it is designed for config/POJO data.
 */
export function cloneDeep<T>(v: T): T {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v) as T;
  if (Array.isArray(v)) return v.map(cloneDeep) as unknown as T;
  if (Object.getPrototypeOf(v) === Object.prototype) {
    const o = {} as { [K in keyof T]: T[K] };
    for (const k in v) o[k as keyof T] = cloneDeep((v as T)[k as keyof T]);
    return o;
  }
  return v;
}

/**
 * Convert a `Date` or epoch seconds into a numeric seconds since epoch, preserving `undefined`.
 *
 * @param value - A `Date`, epoch milliseconds `number`, or `undefined`.
 * @returns Epoch milliseconds if provided, otherwise `undefined`.
 *
 * @example
 * ```ts
 * valueOfDate(new Date(0))  // 0
 * valueOfDate(1730000000000) // 1730000000000
 * valueOfDate(undefined)     // undefined
 * ```
 */
export function epochSeconds(
  value: Date | number | undefined
): number | undefined {
  if (value == undefined) return undefined;

  return typeof value === 'number' ? value : millisToSeconds(value.valueOf());
}

/**
 * Converts a duration from milliseconds to whole seconds.
 *
 * @param {number} millis - The duration in milliseconds.
 * @returns {number} The duration in whole seconds, truncated (not rounded).
 *
 * @example
 * millisToSeconds(1234); // returns 1
 * millisToSeconds(2500); // returns 2
 */
export function millisToSeconds(millis: number): number {
  return Math.trunc(millis / 1_000);
}

/**
 * Return a trimmed string or a supplied default when empty/whitespace/undefined.
 *
 * @param s - Input string (possibly `undefined`).
 * @param defaultValue - Fallback to use when `s` is missing or blank.
 * @returns `s.trim()` if non-empty; otherwise `defaultValue`.
 *
 * @example
 * ```ts
 * defaultString('  hi  ', 'x') // 'hi'
 * defaultString('   ', 'x')    // 'x'
 * defaultString(undefined, 'x') // 'x'
 * ```
 */
export function defaultString(
  s: string | undefined,
  defaultValue: string
): string {
  s = s?.trim();

  return s?.length ? s : defaultValue;
}

/**
 * Generate a pseudo-random Firebase-like user ID.
 *
 * @returns An alphanumeric string of length 28.
 *
 * @remarks
 * - Uses `Math.random()`; **not cryptographically secure**.
 * - Suitable for tests and mock identities.
 */
export function userId(): string {
  return alphanumericId(28);
}

/**
 * Generate a pseudo-random numeric Firebase project number.
 *
 * @returns A numeric string of length 12, not starting with 0.
 *
 * @remarks
 * Uses `Math.random()`; **not cryptographically secure**.
 */
export function projectNumber(): string {
  return numericId(12);
}

/**
 * Build a Firebase-like web App ID from a project number.
 *
 * @param projectNumber - A 12-digit numeric string (see {@link projectNumber}).
 * @returns A string like `1:<projectNumber>:web:<hex>`.
 *
 * @remarks
 * - The trailing hex segment is 22 hex chars generated via `Math.random()`; **not cryptographically secure**.
 * - Intended for mocks/tests only.
 */
export function appId(projectNumber: string): string {
  return `1:${projectNumber}:web:${hexId(22)}`;
}

/**
 * Generate a pseudo-random numeric identifier of a given length.
 *
 * @param length - Total length (1–128). First digit is 1–9 (no leading zero).
 * @returns A numeric string.
 *
 * @remarks
 * Uses `Math.random()`; **not cryptographically secure**.
 * @internal
 */
export function numericId(length: number): string {
  const first = id('123456789', 1);

  return length > 1 ? first + id('0123456789', length - 1) : first;
}

/**
 * Generate a pseudo-random lowercase-hex identifier.
 *
 * @param length - Length (1–128).
 * @returns A hex string using `[0-9a-f]`.
 *
 * @remarks
 * Uses `Math.random()`; **not cryptographically secure**.
 * @internal
 */
export function hexId(length: number): string {
  return id('abcdef0123456789', length);
}

/**
 * Generate a pseudo-random alphanumeric identifier.
 *
 * @param length - Length (1–128).
 * @returns A string using `A-Za-z0-9`.
 *
 * @remarks
 * Uses `Math.random()`; **not cryptographically secure**.
 * @internal
 */
export function alphanumericId(
  length: number,
  typecase: 'lower' | 'upper' | 'both' = 'both'
): string {
  let chars: string;
  switch (typecase) {
    case 'lower':
      chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      break;

    case 'upper':
      chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      break;

    default:
      chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      break;
  }
  return id(chars, length);
}

/**
 * Generates a URL-safe base64-like string of the specified length.
 * No padding character is added.
 * @param length 
 * @returns 
 */
export function base64LikeId(length: number): string {
  return id(
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    length
  );
}

/**
 * Returns a new randomly generated identifier of the specified length.
 *
 * @param chars - Alphabet to draw from.
 * @param length - A value between **1 and 128** inclusive.
 * @returns A new pseudo-random id string.
 *
 * @throws {Error} If `length` is out of range.
 *
 * @remarks
 * - Uses `Math.random()` to pick characters; **not cryptographically secure**.
 * - Suitable for test data and mock identifiers.
 * @internal
 */
function id(chars: string, length: number): string {
  if (length < 1 || length > 128)
    throw new Error('`length` must be between 1 and 128');

  let autoId = '';
  for (let i = 0; i < length; i++) {
    autoId += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return autoId;
}
