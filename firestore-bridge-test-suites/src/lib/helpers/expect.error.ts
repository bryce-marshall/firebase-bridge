import { expect } from '@jest/globals';
import { fail } from 'assert';
import { GoogleError, Status } from 'google-gax';

/**
 * Shape of an error possibly containing a gRPC status code and/or message.
 */
export interface MaybeError {
  code?: Status;
  message?: string;
}
/**
 * Expected error matcher: provide any combination of gRPC `code`,
 * exact `message`, or regex `match`. At least one must be present.
 */
export type ErrorMatch = AtLeastOne<{
  code: Status;
  message: string;
  match: RegExp;
  literal: string;
}>;

/** Utility: require at least one key from T */
type AtLeastOne<T, K extends keyof T = keyof T> = K extends keyof T
  ? Required<Pick<T, K>> & Partial<Omit<T, K>>
  : never;

/**
 * A function that evaluates a thrown/rejected error using `expect` or `fail`.
 *
 * @param error The error to evaluate.
 */
export type ErrorEvalFunction = (error: unknown) => void;

/**
 * Represents a flexible error evaluator.
 *
 * Can be either:
 * - A function that inspects an error and applies `expect` assertions
 * - A declarative object specifying expected `code` and/or `message` values
 */
export type ErrorEvaluator = ErrorEvalFunction | ErrorMatch;

/**
 * Utility for asserting that errors are thrown or rejected as expected
 * in Jest test environments.
 *
 * Provides helpers for both synchronous and asynchronous error evaluation,
 * including validation against Google Cloud Firestore error codes.
 */
export class ExpectError {
  /**
   * Expects an asynchronous function to reject (throw in a Promise).
   *
   * @param fn A function returning a `Promise` expected to reject.
   * @param evaluator How the error should be evaluated.
   * @throws Fails the test if the promise resolves or throws synchronously.
   */
  static async async(
    fn: () => Promise<unknown>,
    evaluator: ErrorEvaluator
  ): Promise<void> {
    const BaseMessage = 'Expected Promise to reject asynchronously';
    try {
      return fn()
        .then(() => {
          fail(`${BaseMessage}.`);
        })
        .catch((e) => {
          ExpectError.evaluate(e, evaluator);
        });
    } catch {
      fail(`${BaseMessage}, but a synchronous error was thrown.`);
    }
  }

  /**
   * Expects a function returning a `Promise` to throw synchronously
   * before resolution.
   *
   * Useful when the implementation throws immediately rather than
   * scheduling an async rejection.
   *
   * @param fn A function returning a `Promise`.
   * @param evaluator How the error should be evaluated.
   */
  static async sync(
    fn: () => Promise<unknown>,
    evaluator: ErrorEvaluator
  ): Promise<void> {
    ExpectError.inline(fn, evaluator);
    return Promise.resolve();
  }

  /**
   * Expects a synchronous function to throw immediately.
   *
   * @param fn A function expected to throw.
   * @param evaluator How the error should be evaluated.
   * @throws Fails the test if the function does not throw.
   */
  static inline(fn: () => unknown, evaluator: ErrorEvaluator): void {
    try {
      fn();
      fail('Expected operation to throw synchronously.');
    } catch (e) {
      ExpectError.evaluate(e as Error, evaluator);
    }
  }

  /**
   * Creates an evaluator that checks for a specific gRPC status code.
   *
   * @param status The expected {@link Status}.
   * @returns An {@link ErrorEvaluator} that validates the code.
   */
  static status(status: Status): ErrorEvaluator {
    return (error: unknown) => {
      this.googleError(error, status);
    };
  }

  /**
   * Validates that an error is a `GoogleError` with a given status and optional message.
   *
   * @param error The thrown error.
   * @param status The expected {@link Status}.
   * @param message Optional expected error message.
   */
  static googleError(error: unknown, status: Status, message?: string): void {
    expect(error).toBeDefined();
    if (message != undefined) {
      expect((error as GoogleError).message).toEqual(message);
    }
    expect((error as GoogleError).code).toEqual(status);
  }

  /**
   * Evaluates an error against an evaluator.
   *
   * - If the evaluator is a function, it is invoked with the error.
   * - If the evaluator is an {@link ErrorMatch}, assertions are applied
   *   against `code`, `message`, and/or regex `match`.
   */
  static evaluate(error: MaybeError, evaluator: ErrorEvaluator): void {
    if (typeof evaluator === 'function') {
      evaluator(error);
      return;
    }

    const { code, message, match, literal } = evaluator;

    if (code !== undefined) {
      if (error.code !== code) {
        dumpEvalError(error, 'Error missing expected code', {
          expected: code,
          actual: error.code,
          message: error.message,
        });
      }
      expect(error.code).toEqual(code);
    }

    if (message !== undefined) {
      if (error.message !== message) {
        dumpEvalError(error, 'Error message mismatch', {
          expected: message,
          actual: error.message,
        });
      }
      expect(error.message).toEqual(message);
    }

    if (match !== undefined) {
      const actual = error.message ?? '';
      if (!match.test(actual)) {
        dumpEvalError(error, 'Error message failed regex match', {
          pattern: match,
          actual,
        });
      }
      expect(actual).toMatch(match);
    }

    if (literal !== undefined) {
      if (literal !== error) {
        dumpEvalError(error, 'Error message failed regex match', {
          literal,
          actual: error,
        });
      }
    }
  }
}

function dumpEvalError(e: unknown, msg: string, detail: unknown): void {
  const state = expect.getState();
  console.log(`[${state.currentTestName ?? ''}]\n${msg}`, detail, e);
}
