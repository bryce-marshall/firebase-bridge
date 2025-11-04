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
function encodeJWT<T>(token: T): string {
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
function decodeJWT<T>(encoded: string): T {
  const parts = encoded.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid JWT: expected at least header and payload parts.');
  }

  const payloadJson = base64UrlDecode(parts[1]);
  return JSON.parse(payloadJson) as T;
}

/**
 * Encode a UTF-8 string to base64url (RFC 7515) form.
 *
 * - Uses standard base64
 * - Strips `=`
 * - Replaces `+` with `-`
 * - Replaces `/` with `_`
 *
 * @param value - The string to encode.
 * @returns The base64url-encoded string.
 */
function base64UrlEncode(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Decode a base64url string back to a UTF-8 string.
 *
 * - Restores padding
 * - Reverts `-` → `+` and `_` → `/`
 *
 * @param value - The base64url string to decode.
 * @returns The decoded UTF-8 string.
 * @throws If the input cannot be padded to valid base64.
 */
function base64UrlDecode(value: string): string {
  let base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  else if (pad !== 0) {
    throw new Error('Invalid base64url string.');
  }

  return Buffer.from(base64, 'base64').toString('utf8');
}
