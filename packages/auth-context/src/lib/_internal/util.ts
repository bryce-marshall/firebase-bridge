import { AuthDateConstructor } from '../types.js';

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
  const seen = new Map<object, unknown>();

  function walk<T>(v: T): T {
    if (v == null || typeof v !== 'object') return v;
    if (v instanceof Date) return new Date(v) as T;

    // If we've seen this object/array before, return the clone
    if (seen.has(v)) return seen.get(v) as T;

    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      // store before recursing to handle self-refs
      seen.set(v as object, arr);
      for (let i = 0; i < v.length; i++) {
        arr[i] = walk(v[i]);
      }
      return arr as unknown as T;
    }

    if (Object.getPrototypeOf(v) === Object.prototype) {
      const o = {} as { [K in keyof T]: T[K] };
      // store before recursing
      seen.set(v as object, o);
      for (const k in v) {
        o[k as keyof T] = walk((v as T)[k as keyof T]);
      }
      return o;
    }

    return v;
  }

  return walk(v);
}

const INVALID_DATE_CONSTRUCTOR_MSG = 'Invalid AuthDateConstructor';

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
export function epochSeconds(value: AuthDateConstructor): number {
  switch (typeof value) {
    case 'number':
      return value;

    case 'string':
      return millisToSeconds(new Date(value).valueOf());

    case 'object':
      return millisToSeconds((value as Date).valueOf());

    default:
      throw new Error(INVALID_DATE_CONSTRUCTOR_MSG);
  }
}

/**
 * Generates a UTC Date string from an `AuthDateConstructor`.
 */
export function utcDate(value: AuthDateConstructor): string {
  switch (typeof value) {
    case 'number':
      return new Date(secondsToMillis(value)).toUTCString();

    case 'object':
      return (value as Date).toUTCString();

    case 'string':
      return new Date(value).toUTCString();

    default:
      throw new Error(INVALID_DATE_CONSTRUCTOR_MSG);
  }
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

export function secondsToMillis(millis: number): number {
  return Math.round(millis * 1_000);
}

/**
 * Parses an ISO date and returns the date expressed as seconds elapsed since the Unix epoch.
 */
export function isoDateToEpoch(
  iso: string | null | undefined
): number | undefined {
  if (!iso) return undefined;

  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : millisToSeconds(ms);
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
 * The minimum latency to apply. Note that `queueMicrotask()` does not guarantee sufficient
 * latency to recreate certain transactional conflicts that might otherwise occur in the
 * production/emulator environments.
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

/**
 * Returns a `Promise` that rejects asynchronously using `queueMicrotask`.
 */
export function rejectPromise<T>(reason: unknown): Promise<T> {
  return new Promise<T>((_resolve, reject) => {
    queueMicrotask(() => reject(reason));
  });
}

/**
 * Assigns the `value` to `target` if value is defined and not an empty string and the target property
 * is not already defined.
 */
export function assignDefer<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
) {
  const existing = target[key];
  if (existing == undefined || existing === '') {
    assignIf(target, key, value);
  }
}

/**
 * Assigns the `value` to `target` if value is defined and not an empty string.
 *
 * @returns `true` if the assignment occurred; otherwise `false`.
 */
export function assignIf<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined | null
): boolean {
  if (value == undefined || value === '') return false;
  target[key] = value;

  return true;
}

/**
 * Assigns the `value` to `target` if value is defined and not an empty string,
 * or deletes the
 *
 * @returns `true` if the assignment or deletion occurred; otherwise `false`.
 */
export function assignIfOrDeleteNull<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined | null
): boolean {
  if (value === undefined || value === '') return false;
  if (value == null) {
    delete target[key];
  } else {
    target[key] = value;
  }
  return true;
}

/**
 * Checks whether the provided value appears to be a valid email address.
 *
 * @remarks
 * This helper performs a pragmatic validation suitable for most application-level
 * checks. It does **not** attempt to fully implement RFC 5322, but it enforces:
 *
 * - Non-empty value after trimming.
 * - No spaces.
 * - At most 320 characters in total.
 * - Exactly one `@` symbol.
 * - Non-empty local part and domain.
 * - Domain contains at least one `.` (for example, `example.com`).
 * - Domain consists of dot-separated labels using letters, digits, or hyphens,
 *   with no empty labels and no labels starting or ending with `-`.
 *
 * `null` and `undefined` are treated as invalid and return `false`.
 *
 * @param email - Email address to validate.
 * @returns `true` if the value looks like a valid email address; otherwise `false`.
 *
 * @example
 * ```ts
 * isValidEmail('alice@example.com');      // true
 * isValidEmail('alice.smith@sub.example.com'); // true
 * isValidEmail('not-an-email');          // false
 * isValidEmail('foo@bar');               // false
 * isValidEmail(null);                    // false
 * ```
 */
export function isValidEmail(email: string | null | undefined): boolean {
  if (!email) return false;

  const value = email.trim();
  if (!value) return false;

  // Basic length guard (common practical limit: 320 characters total).
  if (value.length > 320) return false;

  // Must contain exactly one '@'.
  const atIndex = value.indexOf('@');
  if (atIndex <= 0 || atIndex === value.length - 1) return false;
  if (value.indexOf('@', atIndex + 1) !== -1) return false;

  // No spaces allowed.
  if (value.indexOf(' ') !== -1) return false;

  const localPart = value.slice(0, atIndex);
  const domain = value.slice(atIndex + 1);

  if (!localPart || !domain) return false;

  // Domain must contain at least one dot and not start or end with a dot.
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) {
    return false;
  }

  const domainLabels = domain.split('.');
  if (domainLabels.some((label) => !label)) {
    // Empty label (e.g., "example..com")
    return false;
  }

  // Local part: reasonably permissive, but exclude obvious invalid characters.
  const localPattern = /^[^"(),:;<>@[\\\]\s]+$/;
  if (!localPattern.test(localPart)) return false;

  // Domain labels: letters, digits, hyphens; no leading/trailing hyphen.
  const domainLabelPattern = /^[A-Za-z0-9-]+$/;
  if (
    !domainLabels.every(
      (label) =>
        domainLabelPattern.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-')
    )
  ) {
    return false;
  }

  return true;
}

/**
 * Tests whether a string is a valid E.164-formatted phone number.
 *
 * @remarks
 * E.164 numbers:
 *
 * - Start with a `'+'` sign.
 * - Are followed by a country code and subscriber number.
 * - Contain only digits after the `'+'`.
 * - Have a maximum of 15 digits in total.
 * - Do not start with a leading zero after the `'+'` (i.e. country code
 *   must be `1–9`).
 *
 * This function only validates the **format** of the number. It does not
 * check whether the number is actually assigned or reachable.
 *
 * `null` and `undefined` are treated as invalid and return `false`.
 *
 * @param phoneNumber - Phone number to validate.
 * @returns `true` if the value is a syntactically valid E.164 number; otherwise `false`.
 *
 * @example
 * ```ts
 * isValidE164Phone('+15551234567');   // true
 * isValidE164Phone('+64211234567');   // true (NZ mobile example)
 * isValidE164Phone('5551234567');     // false (missing '+')
 * isValidE164Phone('+0123456789');    // false (country code cannot start with 0)
 * isValidE164Phone(null);            // false
 * ```
 */
export function isValidE164Phone(
  phoneNumber: string | null | undefined
): boolean {
  if (!phoneNumber) return false;

  const value = phoneNumber.trim();
  if (!value) return false;

  // E.164: '+' followed by 1–15 digits, first digit 1–9.
  return /^\+[1-9]\d{1,14}$/.test(value);
}
