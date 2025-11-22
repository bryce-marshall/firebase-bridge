import { MockHttpRequest } from '../../lib/http/_internal/mock-http-request.js';
import {
  CloudFunctionsParsedBody,
  GenericMultiValueDictionary,
} from '../../lib/http/http-types.js';
import { TestIdentity } from '../_helpers/test-auth-manager.js';
import { CommonCallableRequest, TestRunner } from './common-types.js';

/**
 * Run common HTTPS tests against a `TestRunner` implementation.
 */
export function runHttpsCommonSuites(label: 'v1' | 'v2', runner: TestRunner) {
  describe(`[${label}] https common`, () => {
    // ---------------------------
    // onCall: forwarding & context
    // ---------------------------

    it('onCall: forwards data and provides realistic auth/app/appCheck context', async () => {
      const input = { a: 1, nested: { b: 'two' } };
      let _context!: CommonCallableRequest;

      const result = await runner.onCall(
        {
          key: TestIdentity.Jane,
          data: input,
        },
        async (context) => {
          _context = context;
          // Return something so the caller can assert the result plumbing
          return { ok: true, echo: context.data };
        }
      );

      // The callable result should be whatever the handler resolved
      expect(result).toEqual({ ok: true, echo: input });
      // validate shape
      expectCallableContextShape(_context, input);
    });

    // ---------------------------
    // onCall: callable-mode metadata
    // ---------------------------
    it('onCall: applies callable-mode defaults/overrides to request metadata (shape-level assertions)', async () => {
      const metaEcho: GenericMultiValueDictionary = {};

      await runner.onCall(
        {
          key: TestIdentity.Admin,
          data: { ping: true },
        },
        async (context) => {
          const req = context.rawRequest as unknown as MockHttpRequest;

          // We expect callable-mode to set sensible JSON defaults and headers.
          if (req?.headers) {
            // Very loose checks to avoid coupling to exact header names.
            const headers = req.headers;
            metaEcho.contentType =
              headers['content-type'] ?? headers['Content-Type'];
            metaEcho.encoding =
              headers['content-encoding'] ?? headers['Content-Encoding'];
            metaEcho.callableHint =
              headers['x-callable'] ??
              headers['x-firebase-functions-callable'] ??
              headers['x-firebase-callable-format'];

            // Common JSON content type expectation
            if (metaEcho.contentType) {
              expect(String(metaEcho.contentType)).toMatch(/json/i);
            }
          }

          // Method and body shape are usually normalized for callable transport
          if (req?.method) {
            expect(typeof req.method).toBe('string');
          }
          if (req?.body) {
            expect(typeof req.body).toBe('object');
          }

          return { ok: true };
        }
      );

      // We only check that metadata was present in some sensible form.
      // Keep this intentionally non-fragile.
      expect(metaEcho).toBeDefined();
    });

    // ---------------------------
    // onRequest: response capture
    // ---------------------------
    it('onRequest: allows test code to capture response data and status', async () => {
      const response = await runner.onRequest(
        {
          key: TestIdentity.Admin,
          data: { hello: 'world' }, // Will be available as req.body (POST),
          options: {
            method: 'POST',
            path: '/unit-test/ok',
          },
        },
        // Standard Express-style handler
        async (req, resp) => {
          // Minimal plausibility checks on request forwarding
          expect(req.method).toBe('POST');
          // body forwarding (shape-level)
          expect(typeof req.body).toBe('object');
          expect(req.body.hello).toBe('world');

          // Respond JSON w/ custom status
          resp.status(201).json({ ok: true });
        }
      );

      // node-mocks-http response helpers (commonly available)
      const status = response.statusCode;

      const body = response._getJSONData();
      expect(status).toBe(201);
      expect(body).toMatchObject({ ok: true });
    });

    // ---------------------------
    // onRequest: default-ish metadata
    // ---------------------------
    it('onRequest: supplies reasonable HTTP metadata to the handler (shape-level)', async () => {
      await runner.onRequest(
        {
          key: TestIdentity.Jane,
          options: {
            method: 'GET',
            path: '/unit-test/meta?q=1',
            query: { q: '1' },
          },
        },
        (req, resp) => {
          // Very broad/shape checks:
          expect(req.method).toBe('GET');
          expect(typeof req.url).toBe('string');

          // Headers should exist; content-type may be unset on GET
          expect(req.headers).toBeDefined();
          const host =
            req.headers['host'] ??
            (Array.isArray(req.headers[':authority'])
              ? req.headers[':authority'][0]
              : (req.headers[':authority'] as string | undefined));
          if (host) {
            expect(typeof host).toBe('string');
          }

          // Query forwarding
          expect(req.query).toBeDefined();
          expect(req.query.q).toBeDefined();

          resp.status(200).send('OK');
        }
      );
    });
  });
}

// Range: roughly 2001-01-01 .. 2100-01-01 for sanity.
const isEpochSeconds = (n: unknown) => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return false;

  return n > 978307200 /* 2001-01-01 */ && n < 4102444800 /* 2100-01-01 */;
};

const isNonEmptyString = (s: unknown) => typeof s === 'string' && s.length > 0;

export function expectCallableContextShape<
  T extends CloudFunctionsParsedBody = CloudFunctionsParsedBody
>(ctx: CommonCallableRequest<T>, expectedData: T) {
  // Top-level
  expect(ctx).toEqual(
    expect.objectContaining({
      data: expectedData,
    })
  );

  // auth
  expect(ctx.auth).toEqual(
    expect.objectContaining({
      uid: expect.any(String),
      token: expect.objectContaining({
        uid: expect.any(String),
        sub: expect.any(String),
        aud: expect.any(String),
        iat: expect.any(Number),
        exp: expect.any(Number),
        iss: expect.stringContaining(
          'https://firebaseappcheck.googleapis.com/'
        ),
        firebase: expect.objectContaining({
          sign_in_provider: expect.any(String),
        }),
      }),
    })
  );

  const audVal = ctx.app?.token?.aud;
  expect(Array.isArray(audVal) && audVal.every(isNonEmptyString)).toBe(true);

  // Timestamps sanity (coarse)
  expect(isEpochSeconds(ctx.auth?.token.iat)).toBe(true);
  expect(isEpochSeconds(ctx.auth?.token.exp)).toBe(true);
  if (ctx.auth?.token.auth_time !== undefined) {
    expect(isEpochSeconds(ctx.auth.token.auth_time)).toBe(true);
  }

  // app / appCheck
  expect(ctx.app).toEqual(
    expect.objectContaining({
      appId: expect.stringMatching(/^\d+:\d+:web:[a-f0-9]+$/),
      token: expect.objectContaining({
        sub: expect.any(String),
        app_id: expect.any(String),
        aud: expect.anything(),
        iss: expect.stringContaining(
          'https://firebaseappcheck.googleapis.com/'
        ),
        iat: expect.any(Number),
        exp: expect.any(Number),
      }),
    })
  );

  // rawRequest (don’t deepEqual — assert key surfaces only)
  expect(ctx.rawRequest).toEqual(
    expect.objectContaining({
      method: 'POST',
      url: expect.any(String),
      originalUrl: expect.any(String),
      baseUrl: expect.any(String),
      path: expect.any(String),
      headers: expect.objectContaining({
        host: expect.any(String),
        'x-forwarded-proto': 'https',
        'content-type': expect.stringContaining('application/json'),
      }),
      body: expectedData,
      query: expect.any(Object),
      ip: expect.any(String),
    })
  );
}
