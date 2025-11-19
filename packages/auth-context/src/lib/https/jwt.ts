/**
 * Lightweight, JWT-shaped encoder/decoder used by the mock HTTPS functions layer.
 *
 * This module does **not** produce real, signed Firebase tokens. Instead, it
 * creates 3-part JWT-like strings (`header.payload.signature`) so that:
 *
 * - Mock HTTP requests can carry something that **looks like** an AppCheck or
 *   Identity token in a header;
 * - Test/consumer code can reliably extract and decode the payload;
 * - Actual verification (signature, issuer, audience, expiry) can be delegated
 *   to injected mock/production decode/verify functions.
 *
 * The format is intentionally simple:
 * - Header is fixed to `{ alg: "none", typ: "JWT" }`
 * - Payload is the provided decoded token object (IdToken or AppCheck token)
 * - Signature is a fixed string (`"mock-signature"`)
 *
 * This keeps the tokens structurally familiar (3 segments, base64url-encoded)
 * without claiming cryptographic validity.
 */

import { DecodedAppCheckToken } from 'firebase-admin/app-check';
import { DecodedIdToken } from 'firebase-admin/auth';
import {
  base64UrlDecode,
  base64UrlEncode,
  HeaderKey,
} from './_internal/util.js';

/**
 * Extracts and decodes a mock Firebase **Identity (ID) token** from a request's
 * `Authorization` header, if present.
 *
 * This function is designed for use in mock HTTPS request handlers (v1 or v2)
 * where Firebase Auth is not actually verified but where a realistic JWT-shaped
 * header value may still be provided.
 *
 * It expects the header format:
 * ```
 * Authorization: Bearer <mock-jwt>
 * ```
 *
 * If the header is missing, malformed, or decoding fails, `undefined` is returned.
 *
 * @param request - The HTTP `Request` (Fetch API or Express-compatible) containing headers.
 * @returns The decoded `DecodedIdToken` payload, or `undefined` if absent or invalid.
 *
 * @example
 * ```ts
 * const token = getMockIdToken(req);
 * if (token) console.log(`Authenticated as ${token.uid}`);
 * ```
 */
export function getMockIdToken(request: Request): DecodedIdToken | undefined {
  const authHeader = request.headers.get(HeaderKey.Authorization) ?? '';
  const match = authHeader.match(/^Bearer (.+)$/i);

  return safeDecodeJWT(match?.[1]);
}

/**
 * Extracts and decodes a mock Firebase **AppCheck token** from a request's
 * `X-Firebase-AppCheck` (or equivalent) header, if present.
 *
 * This is the AppCheck analogue of {@link getMockIdToken}. It assumes the header
 * directly contains the mock JWT string (no `"Bearer "` prefix).
 *
 * If the header is missing or cannot be decoded, `undefined` is returned.
 *
 * @param request - The HTTP `Request` containing headers.
 * @returns The decoded `DecodedAppCheckToken` payload, or `undefined` if absent or invalid.
 *
 * @example
 * ```ts
 * const appCheck = getMockAppCheckToken(req);
 * if (appCheck) console.log(`App verified: ${appCheck.app_id}`);
 * ```
 */
export function getMockAppCheckToken(
  request: Request
): DecodedAppCheckToken | undefined {
  return safeDecodeJWT(request.headers.get(HeaderKey.AppCheck));
}

/**
 * Encode a decoded Firebase **Identity** token (as produced by admin SDKs)
 * into a JWT-like string suitable for transport in HTTP headers.
 *
 * @param token - The decoded ID token object.
 * @returns A JWT-shaped string with 3 segments.
 */
export function encodeIdToken(token: DecodedIdToken): string {
  return encodeJWT(token);
}

/**
 * Decode a JWT-like string (produced by {@link encodeIdToken}) back into a
 * `DecodedIdToken`.
 *
 * @param encoded - The JWT-shaped string to decode.
 * @returns The decoded ID token payload.
 * @throws If the string is not in the expected JWT 2+ segment format.
 */
export function decodeIdToken(encoded: string): DecodedIdToken {
  return decodeJWT<DecodedIdToken>(encoded);
}

/**
 * Encode a decoded Firebase **AppCheck** token into a JWT-like string suitable
 * for inclusion in HTTP headers (e.g. `x-firebase-appcheck`).
 *
 * @param token - The decoded AppCheck token object.
 * @returns A JWT-shaped string with 3 segments.
 */
export function encodeAppCheckToken(token: DecodedAppCheckToken): string {
  return encodeJWT(token);
}

/**
 * Decode a JWT-like string (produced by {@link encodeAppCheckToken}) back into
 * a `DecodedAppCheckToken`.
 *
 * @param encoded - The JWT-shaped string to decode.
 * @returns The decoded AppCheck token payload.
 * @throws If the string is not in the expected JWT 2+ segment format.
 */
export function decodeAppCheckToken(encoded: string): DecodedAppCheckToken {
  return decodeJWT<DecodedAppCheckToken>(encoded);
}

/**
 * Internal utility to create a JWT-shaped string from an arbitrary payload.
 *
 * Structure:
 * - header: `{ alg: "none", typ: "JWT" }`
 * - payload: the provided token object
 * - signature: `"mock-signature"`
 *
 * This is **not** a real signer: no keys, no claims validation, no crypto.
 *
 * @typeParam T - Shape of the payload being encoded.
 * @param token - The payload to embed in the JWT body.
 * @returns A string in the form `header.payload.signature`.
 */
export function encodeJWT<T>(token: T): string {
  const header = { alg: 'none', typ: 'JWT' };
  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(token));
  const signaturePart = 'mock-signature';
  return `${headerPart}.${payloadPart}.${signaturePart}`;
}

/**
 * Internal utility to decode a JWT-shaped string produced by {@link encodeJWT}
 * and return the payload as a typed object.
 *
 * Only the payload is used; header and signature are ignored.
 *
 * @typeParam T - Expected shape of the decoded payload.
 * @param encoded - The JWT-shaped string to decode.
 * @returns The decoded payload.
 * @throws If the encoded string is not in JWT format or is not valid base64url.
 */
export function decodeJWT<T>(encoded: string): T {
  const parts = encoded.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT: expected at least header and payload parts.');
  }

  const payloadJson = base64UrlDecode(parts[1]);
  return JSON.parse(payloadJson) as T;
}

/**
 * Safely decodes a JWT-like string (as produced by {@link encodeJWT}) into a typed
 * object, suppressing all errors and returning `undefined` for invalid inputs.
 *
 * This helper provides defensive decoding suitable for request handlers where
 * malformed or missing headers should not trigger runtime errors.
 *
 * @typeParam T - The expected payload type (e.g. `DecodedIdToken`).
 * @param encoded - The base64url JWT-like string to decode.
 * @returns The decoded payload, or `undefined` if the string is missing or invalid.
 *
 * @example
 * ```ts
 * const token = safeDecodeJWT<DecodedIdToken>(maybeJwt);
 * if (!token) return res.status(401).send('Invalid token');
 * ```
 */
function safeDecodeJWT<T>(encoded: string | undefined | null): T | undefined {
  if (!encoded) return undefined;
  try {
    return decodeJWT(encoded);
  } catch {
    return undefined;
  }
}
