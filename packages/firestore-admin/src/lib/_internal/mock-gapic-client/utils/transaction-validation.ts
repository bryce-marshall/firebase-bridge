import type { google } from '@gcf/firestore-protos';
import {
  assertEitherRequired,
  assertInstanceOf,
  assertMutuallyExclusive,
  assertNotEmpty,
} from './assert.js';

/**
 * Validates a GAPIC {@link google.firestore.v1.ITransactionOptions} object.
 *
 * Semantics enforced:
 * - Exactly one of `readOnly` or `readWrite` must be specified.
 * - If `readWrite.retryTransaction` is present, it must be a non-empty `Uint8Array`.
 *
 * Behavior:
 * - If `options` is `null`/`undefined`, validation is a no-op.
 * - Violations throw a `GoogleError` with `Status.INVALID_ARGUMENT` via the shared
 *   assertion helpers in `./assert`.
 *
 * Expected shapes (subset):
 * ```ts
 * // Read-only transaction
 * { readOnly: { readTime?: google.protobuf.ITimestamp } }
 *
 * // Read-write transaction
 * { readWrite: { retryTransaction?: Uint8Array } }
 * ```
 *
 * @param options - The transaction options to validate.
 * @throws {GoogleError} If both or neither of `readOnly` / `readWrite` are provided,
 *                       or if `readWrite.retryTransaction` is not a non-empty `Uint8Array`.
 */
export function validateTransactionOptions(
  options: google.firestore.v1.ITransactionOptions | null | undefined
): void {
  if (options == undefined) return;

  assertEitherRequired(
    'readOnly',
    options.readOnly,
    'readWrite',
    options.readWrite
  );
  assertMutuallyExclusive(
    'readOnly',
    options.readOnly,
    'readWrite',
    options.readWrite
  );
  assertInstanceOf(
    'readonly.retryTransaction',
    'Uint8Array',
    options.readWrite?.retryTransaction,
    Uint8Array,
    false
  );
  assertNotEmpty(
    'readonly.retryTransaction',
    options.readWrite?.retryTransaction,
    false
  );
}
