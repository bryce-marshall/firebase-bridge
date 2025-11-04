import { DecodedIdToken } from 'firebase-admin/auth';
import { AuthData } from 'firebase-functions/tasks';
import { execPromise } from '../../_internal/util.js';
import { AuthenticatedRequestContext, UnauthenticatedRequestContext } from '../../types.js';
import { MockHttpResponse } from '../mock-http-response.js';

/**
 * Format an ID token issuer (`iss`) string for a given project.
 *
 * @param projectNumber - Firebase project number.
 * @returns Issuer URL like `https://firebaseappcheck.googleapis.com/<PROJECT_NUMBER>`.
 */
export function formatIss(projectNumber: string): string {
  return `https://firebaseappcheck.googleapis.com/${projectNumber}`;
}

/**
 * Build {@link AuthData} for callable handlers from a generic auth context.
 *
 * @param context - The version-agnostic auth context produced by the provider.
 * @returns An `AuthData` object containing `uid` and a `DecodedIdToken`.
 *
 * @remarks
 * - The returned `uid` mirrors the identity’s `uid` (i.e., the `sub` claim).
 * - The returned token is a **decoded** shape that merges standard JWT claims
 *   with fields from {@link AuthenticatedRequestContext} identity.
 */
export function buildAuthData(
  context: UnauthenticatedRequestContext | AuthenticatedRequestContext
): AuthData | undefined {
  if ((context as AuthenticatedRequestContext).identity == undefined) return undefined;
  const token = buildToken(context as AuthenticatedRequestContext);

  return { uid: token.uid as string, token };
}

/**
 * Build the App Check object surfaced on callable requests (v1/v2).
 *
 * @param app - Optional App Check payload with `appId` and a token.
 * @returns `{ appId, token }` if `app` is provided; otherwise `undefined`.
 *
 * @remarks
 * This is a shaping helper; it does not validate the token.
 */
export function buildAppData(app?: { appId: string; token?: unknown }) {
  return app ? { appId: app.appId, token: app.token } : undefined;
}

/**
 * Construct a `DecodedIdToken` from a {@link AuthenticatedRequestContext}.
 *
 * @internal
 *
 * @param context - Generic auth context containing identity and timing claims.
 * @returns A `DecodedIdToken` with `sub`, `aud`, `iat`, `exp`, `auth_time`, plus identity claims.
 *
 * @remarks
 * - `sub` is set from `identity.uid`.
 * - `aud` is the project id.
 * - Identity fields are spread into the token to emulate decoded ID token structure.
 */
function buildToken(context: AuthenticatedRequestContext): DecodedIdToken {
  const uid = context.identity.uid;
  return {
    sub: uid,
    aud: context.projectId,
    iat: context.iat,
    exp: context.exp,
    auth_time: context.auth_time,
    ...context.identity,
  };
}

/**
 * Resolve when the HTTP response lifecycle completes.
 *
 * @typeParam T - The result value type to resolve with after completion.
 *
 * @param res - The mocked HTTP response (e.g., from `node-mocks-http`).
 * @param result - Value to resolve once the response finishes.
 * @returns A promise that resolves to `result` after the response ends, or rejects on error.
 *
 * @remarks
 * - Works with both Express and `node-mocks-http`:
 *   - Express emits `'finish'`.
 *   - `node-mocks-http` emits `'end'` (and sometimes `'close'`).
 * - If the response is already ended, resolves immediately.
 */
export function awaitResponse<T>(res: MockHttpResponse, result: T): Promise<T> {
  // node-mocks-http sets finished/end flags; Express emits 'finish'
  if (res.writableEnded || res.writableEnded) {
    return Promise.resolve<T>(result);
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      res.off?.('finish', onFinish);
      res.off?.('end', onFinish);
      res.off?.('close', onFinish);
      res.off?.('error', onError);
    };
    const onFinish = () => {
      cleanup();
      resolve(result);
    };
    const onError = (e: unknown) => {
      cleanup();
      reject(e as Error);
    };

    // node-mocks-http emits 'end'; Express emits 'finish'
    res.once?.('finish', onFinish);
    res.once?.('end', onFinish);
    res.once?.('close', onFinish);
    res.once?.('error', onError);
  });
}

/**
 * Execute an operation and then wait for the HTTP response to complete.
 *
 * @typeParam T - The result value type of the operation.
 *
 * @param executor - Function to invoke (may be sync or async).
 * @param response - The mocked HTTP response to await.
 * @returns A promise resolving with the executor’s result once the response finishes.
 *
 * @remarks
 * - Wraps {@link execPromise} to normalize sync/async execution paths.
 * - Chains to {@link awaitResponse} to ensure response completion before resolving.
 */
export function execAndAwaitResponse<T>(
  executor: () => T | Promise<T>,
  response: MockHttpResponse
): Promise<T> {
  return execPromise(executor).then((v) => awaitResponse(response, v));
}
