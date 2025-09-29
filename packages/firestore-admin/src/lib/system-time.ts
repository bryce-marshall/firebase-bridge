/**
 * A controllable time source for use within the Firestore mock.
 *
 * This utility enables deterministic and testable control over "system time" as perceived
 * by the mock Firestore implementation. By default, `SystemTime` returns the real current
 * time (`new Date()`), but developers can override this behavior to return a fixed timestamp
 * or a dynamic value with a specified offset.
 *
 * @example
 * const time = new SystemTime();
 * time.constant(new Date('2020-01-01T00:00:00Z'));
 * console.log(time.now()); // Always returns the same date
 *
 * time.system();
 * console.log(time.now()); // Returns real current time
 *
 * time.offset(new Date('2023-01-01T00:00:00Z'));
 * // Returns a date that tracks the same delta as real time since this offset root
 */
export class SystemTime {
  /** @internal The generator function used to return the current system time. */
  private _generator: GenFn = system;

  /**
   * Returns the current time according to the active generator strategy.
   *
   * @returns A `Date` instance representing "now" from the perspective of the configured time strategy.
   */
  now(): Date {
    return this._generator();
  }

  /**
   * Locks the internal time to a constant value. All calls to `now()` will return a copy
   * of the provided date.
   *
   * @param date - A `Date` object to fix as the current time.
   */
  constant(date: Date): void {
    const n = date.valueOf();
    this._generator = () => new Date(n);
  }

  /**
   * Resets the time source to real system time. All calls to `now()` will return `new Date()`.
   */
  system(): void {
    this._generator = system;
  }

  /**
   * Sets the time source to a moving offset from a fixed root date.
   *
   * The returned time increases in real time, starting from the `root` date.
   * Internally, this preserves the delta between the original root and real system time
   * when the method was invoked.
   *
   * @param root - A `Date` instance representing the base time to start offsetting from.
   */
  offset(root: Date): void;

  /**
   * Sets the time source to a moving offset from a root date constructed from parts.
   *
   * @param year - The full year (e.g., 2024)
   * @param month - The month (0-based, January is 0)
   * @param day - The day of the month (1-based). Defaults to 1.
   * @param hour - The hour. Defaults to 0.
   * @param minute - The minute. Defaults to 0.
   * @param second - The second. Defaults to 0.
   * @param millisecond - The millisecond. Defaults to 0.
   */
  offset(
    year: number,
    month: number,
    day?: number,
    hour?: number,
    minute?: number,
    second?: number,
    millisecond?: number
  ): void;

  offset(
    p1: Date | number,
    month?: number,
    day?: number,
    hour?: number,
    minute?: number,
    second?: number,
    millisecond?: number
  ): void {
    const root = (
      isDate(p1)
        ? p1
        : new Date(
            p1 as number,
            month ?? 0,
            day ?? 1,
            hour ?? 0,
            minute ?? 0,
            second ?? 0,
            millisecond ?? 0
          )
    ).valueOf();
    const now = Date.now();

    this._generator = () => {
      const n = Date.now();
      return new Date(root + (n - now));
    };
  }

  /**
   * Advances the current time by the specified number of milliseconds.
   *
   * This method is useful in tests where deterministic progression of time is needed.
   * Internally, it retrieves the current "now" from the active generator, adds the
   * given number of milliseconds, and reconfigures the time source using `offset()`
   * so that real time continues from the new advanced timestamp.
   *
   * If no value is provided, the time is advanced by 1 millisecond.
   *
   * @example
   * const time = new SystemTime();
   * time.constant(new Date('2020-01-01T00:00:00Z'));
   * time.advance(1000);
   * console.log(time.now()); // 2020-01-01T00:00:01.000Z
   *
   * @param millis - The number of milliseconds to advance time by. Defaults to 1.
   */
  advance(millis?: number): void {
    const date = this._generator();
    date.setTime(date.getTime() + (millis ?? 1));
    this.offset(date);
  }

  /**
   * Replaces the internal time generator with a custom implementation.
   *
   * This allows test environments to simulate arbitrary time behavior—
   * including randomized timestamps, scheduled sequences, or other
   * domain-specific time simulations.
   *
   * @example
   * let counter = 0;
   * time.custom(() => new Date(Date.UTC(2020, 0, counter++)));
   *
   * @param generator - A function that returns a `Date` object representing the current time.
   */
  custom(generator: () => Date): void {
    this._generator = generator;
  }
}

/**
 * Returns the current system time (equivalent to `new Date()`).
 * Used as the default generator function for `SystemTime`.
 *
 * @returns A `Date` instance representing the current time.
 */
function system(): Date {
  return new Date();
}

/**
 * Determines whether the input is a valid `Date` object.
 * This check is cross-realm safe (e.g., across iframes).
 *
 * @param arg - The value to test.
 * @returns `true` if the value is a `Date` object; otherwise, `false`.
 */
function isDate(arg: unknown): arg is Date {
  return (
    arg != undefined && Object.prototype.toString.call(arg) === '[object Date]'
  );
}

/**
 * Type alias for a function that returns a `Date`.
 */
type GenFn = () => Date;
