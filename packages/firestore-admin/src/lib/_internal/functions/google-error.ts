import { GoogleError, Status } from 'google-gax';

/**
 * Array that maps gRPC status codes (numeric) to their enum key name.
 * E.g. STATUS_CODE_NAMES[3] === "INVALID_ARGUMENT".
 */
const STATUS_CODE_NAMES: string[] = [
  'OK', // 0
  'CANCELLED', // 1
  'UNKNOWN', // 2
  'INVALID_ARGUMENT', // 3
  'DEADLINE_EXCEEDED', // 4
  'NOT_FOUND', // 5
  'ALREADY_EXISTS', // 6
  'PERMISSION_DENIED', // 7
  'RESOURCE_EXHAUSTED', // 8
  'FAILED_PRECONDITION', // 9
  'ABORTED', // 10
  'OUT_OF_RANGE', // 11
  'UNIMPLEMENTED', // 12
  'INTERNAL', // 13
  'UNAVAILABLE', // 14
  'DATA_LOSS', // 15
  'UNAUTHENTICATED', // 16
];

export function googleError(
  code: Status,
  message: string,
  cause?: unknown
): GoogleError {
  const name = STATUS_CODE_NAMES[code];
  return googleErrorClient(
    code,
    name ? `${code} ${name}: ${message}` : message,
    cause
  );
}

export function googleErrorClient(
  code: Status,
  message: string,
  cause?: unknown
): GoogleError {
  const error = new GoogleError(message);
  error.code = code;
  error.cause = cause;

  return error;
}
