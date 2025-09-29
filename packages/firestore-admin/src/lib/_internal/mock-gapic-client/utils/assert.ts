import { Status } from 'google-gax';
import { googleError } from '../../functions/google-error.js';

/**
 * Checks whether a string is a valid Firestore / Google Cloud `projectId`.
 *
 * Rules:
 * - Length: 6–30 characters
 * - Must start with a lowercase ASCII letter
 * - May contain lowercase letters, digits, and hyphens
 * - Must end with a letter or digit (cannot end with hyphen)
 * - Must not contain consecutive hyphens
 *
 * @param projectId - The project ID to validate.
 * @returns `true` if valid; otherwise `false`.
 */
function isValidProjectId(projectId: string): boolean {
  // Length check
  if (projectId.length < 6 || projectId.length > 30) {
    return false;
  }

  // Regex check:
  // ^[a-z]          → must start with lowercase letter
  // [a-z0-9-]*      → allowed characters
  // [a-z0-9]$       → must end with letter or digit
  const pattern = /^[a-z][a-z0-9-]*[a-z0-9]$/;
  if (!pattern.test(projectId)) {
    return false;
  }

  // No consecutive hyphens
  if (projectId.includes('--')) {
    return false;
  }

  return true;
}

/**
 * Asserts that the provided `projectId` conforms to Firestore / Google Cloud rules.
 *
 * @param projectId - The project ID to validate.
 * @returns The same `projectId` when valid (for fluent usage).
 * @throws {GoogleError} {@link Status.INTERNAL} when the project ID is invalid.
 */
export function assertValidProjectId(projectId: string): string {
  if (!isValidProjectId(projectId)) {
    throw googleError(
      Status.INTERNAL,
      `Invalid project ID "${projectId}". Project IDs must be 6–30 characters, start with a lowercase letter, 
       contain only lowercase letters, digits, or hyphens, cannot end with a hyphen, and cannot contain consecutive hyphens.`
    );
  }

  return projectId;
}

/**
 * Asserts that a (possibly optional) value with a `length` property is non-empty.
 *
 * If `required` is `false` and the value is `undefined`/`null`, no error is thrown.
 *
 * @param argName - Name of the argument (for error messages).
 * @param value - The value to check; must have a numeric `length` when present.
 * @param required - Whether the argument is required.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} when required and empty/missing.
 */
export function assertNotEmpty(
  argName: string,
  value: { length: number } | undefined | null,
  required: boolean
): void {
  if (value == undefined && !required) return;

  if (!value?.length) {
    throw googleError(Status.INVALID_ARGUMENT, `"${argName}" cannot be empty.`);
  }
}

/**
 * Asserts that a value is an instance of a constructor or satisfies a predicate.
 *
 * If `required` is `false` and the value is `undefined`/`null`, no error is thrown.
 *
 * @param argName - Name of the argument (for error messages).
 * @param typeName - Human-readable type name for error messaging.
 * @param value - The value to validate.
 * @param type - Either a constructor function (for `instanceof`) or a predicate `(value) => boolean`.
 * @param required - Whether the argument is required.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} when validation fails.
 */
export function assertInstanceOf(
  argName: string,
  typeName: string,
  value: unknown,
  type: (new (...args: unknown[]) => unknown) | ((value: unknown) => boolean),
  required: boolean
): void {
  if (value == undefined && !required) return;

  const isValid = isConstructor(type) ? value instanceof type : type(value);
  if (!isValid) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `"${argName}" must be a ${typeName}.`
    );
  }
}

/**
 * Asserts that two arguments are mutually exclusive—i.e., not both specified.
 *
 * @param argName1 - Name of the first argument.
 * @param value1 - Value of the first argument.
 * @param argName2 - Name of the second argument.
 * @param value2 - Value of the second argument.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} when both are specified.
 */
export function assertMutuallyExclusive(
  argName1: string,
  value1: unknown,
  argName2: string,
  value2: unknown
): void {
  if (value1 != undefined && value2 != undefined) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `Cannot specify both "${argName1}" and "${argName2}".`
    );
  }
}

/**
 * Asserts that at least one of two alternative arguments is provided.
 *
 * @param argName1 - Name of the first argument.
 * @param value1 - Value of the first argument.
 * @param argName2 - Name of the second argument.
 * @param value2 - Value of the second argument.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} when both are missing.
 */
export function assertEitherRequired(
  argName1: string,
  value1: unknown,
  argName2: string,
  value2: unknown
): void {
  if (value1 == undefined && value2 == undefined) {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `Must specify either "${argName1}" or "${argName2}".`
    );
  }
}

/**
 * Asserts that a request field is not supported in the mock and therefore must be absent.
 *
 * @param argName - Name of the unsupported request field.
 * @param value - The field value to check.
 * @throws {GoogleError} {@link Status.UNIMPLEMENTED} when the field is provided.
 */

export function assertRequestArgumentNotSupported(
  argName: string,
  value: unknown
): void {
  if (value != undefined)
    throw googleError(
      Status.UNIMPLEMENTED,
      `The "${argName}" field is not supported in the mock.`
    );
}

/**
 * Asserts that a required request field is present and returns it.
 *
 * @typeParam T - The expected type of the value.
 * @param argName - Name of the required field.
 * @param value - The value to check.
 * @returns The value when present.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} when the field is missing.
 */
export function assertRequestArgument<T>(
  argName: string,
  value: T | null | undefined
): T {
  if (value != undefined) return value;

  throw googleError(
    Status.INVALID_ARGUMENT,
    `Request is missing required field "${argName}".`
  );
}

/**
 * Asserts that a required field *within a fieldFilter* is present and returns it.
 * This mirrors Firestore error messaging for malformed fieldFilter clauses.
 *
 * @typeParam T - The expected type of the value.
 * @param argName - Name of the missing sub-field (e.g., `"op"`, `"value"`, `"fieldPath"`).
 * @param value - The value to check.
 * @returns The value when present.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT} when the sub-field is missing.
 */
export function assertFieldArgument<T>(
  argName: string,
  value: T | null | undefined
): T {
  if (value != undefined) return value;

  throw googleError(
    Status.INVALID_ARGUMENT,
    `Missing ${argName} in fieldFilter.`
  );
}

/**
 * Type guard that determines whether a value is a constructor function.
 *
 * @param fn - A constructor or predicate function.
 * @returns `true` if `fn` is a constructor (has a prototype and constructor); otherwise `false`.
 */
function isConstructor(
  fn: (new (...args: unknown[]) => unknown) | ((value: unknown) => boolean)
): fn is new (...args: unknown[]) => unknown {
  return (
    typeof fn === 'function' && !!fn.prototype && !!fn.prototype.constructor
  );
}
