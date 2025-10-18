import { DocumentData, Firestore, Timestamp } from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { normalizeDocData } from './helpers/document-data.js';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function writeBatchingAndBulkWriterSuite(
  context: FirestoreBridgeTestContext
) {
  const COLLECTION_ID = 'Write Batching and BulkWriter';

  describe(COLLECTION_ID, () => {
    let Firestore!: Firestore;

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    function col() {
      return Firestore.collection(COLLECTION_ID);
    }

    //#region WriteBatch

    describe('WriteBatch', () => {
      it('commits writes; writeResults align to input order (atomic on success)', async () => {
        const a = col().doc('wb-order-a');
        const b = col().doc('wb-order-b');

        const batch = Firestore.batch();
        batch.set(a, { v: 1 });
        batch.set(b, { v: 2 });

        const results = await batch.commit();

        expect(Array.isArray(results)).toBe(true);
        expect(results.length).toBe(2);

        const [as, bs] = await Promise.all([a.get(), b.get()]);
        const ad = as.data() as DocumentData;
        const bd = bs.data() as DocumentData;

        expect(normalizeDocData(ad)).toEqual({ v: 1 });
        expect(normalizeDocData(bd)).toEqual({ v: 2 });
      });

      it('is atomic: a single failing write rejects commit and none are applied', async () => {
        const okDoc = col().doc('wb-atomic-ok');
        const missing = col().doc('wb-atomic-missing');
        const alsoOk = col().doc('wb-atomic-also-ok');

        const batch = Firestore.batch();
        batch.set(okDoc, { a: 1 });
        // This update should fail because the document does not exist.
        batch.update(missing, { b: 2 });
        batch.set(alsoOk, { c: 3 });

        await ExpectError.async(() => batch.commit(), {
          code: Status.NOT_FOUND,
        });

        const [okSnap, missSnap, alsoSnap] = await Promise.all([
          okDoc.get(),
          missing.get(),
          alsoOk.get(),
        ]);

        // Nothing should have been written
        expect(okSnap.exists).toBe(false);
        expect(missSnap.exists).toBe(false);
        expect(alsoSnap.exists).toBe(false);
      });

      it('applies multiple writes to the same document in order', async () => {
        const ref = col().doc('wb-multi-same-doc');

        const batch = Firestore.batch();
        batch.set(ref, { a: 1 });
        batch.update(ref, { b: 2 });
        batch.set(ref, { c: 3 }, { merge: true });

        await batch.commit();

        const snap = await ref.get();
        const d = snap.data() as DocumentData;

        // all writes applied in sequence
        expect(d.a).toBe(1);
        expect(d.b).toBe(2);
        expect(d.c).toBe(3);
      });

      // --- WriteBatch: deletes ---

      it('delete removes an existing document', async () => {
        const ref = col().doc('wb-del-existing');
        await ref.set({ a: 1 });

        const batch = Firestore.batch();
        batch.delete(ref);
        await batch.commit();

        const snap = await ref.get();
        expect(snap.exists).toBe(false);
      });

      it('delete on a missing document succeeds (no-op)', async () => {
        const ref = col().doc('wb-del-missing');

        const batch = Firestore.batch();
        batch.delete(ref); // no precondition -> should succeed as a no-op
        await batch.commit();

        const snap = await ref.get();
        expect(snap.exists).toBe(false);
      });

      it('delete with { exists:true } on missing rejects and batch is atomic', async () => {
        const ok = col().doc('wb-del-atomic-ok');
        const missing = col().doc('wb-del-atomic-missing');

        const batch = Firestore.batch();
        batch.set(ok, { ok: true });
        batch.delete(missing, { exists: true }); // should cause NOT_FOUND
        batch.set(col().doc('wb-del-atomic-never'), { never: true });

        await ExpectError.async(() => batch.commit(), {
          code: Status.NOT_FOUND,
        });

        // Nothing should have been written
        const [a, b] = await Promise.all([ok.get(), missing.get()]);
        expect(a.exists).toBe(false);
        expect(b.exists).toBe(false);
      });

      it('applies multiple ops to same doc with delete in sequence', async () => {
        const ref1 = col().doc('wb-del-order-1');
        const ref2 = col().doc('wb-del-order-2');

        // Case 1: set -> delete ==> final: not exists
        const b1 = Firestore.batch();
        b1.set(ref1, { v: 1 });
        b1.delete(ref1);
        await b1.commit();
        const s1 = await ref1.get();
        expect(s1.exists).toBe(false);

        // Case 2: delete -> set(merge) ==> final: exists with data
        const b2 = Firestore.batch();
        b2.delete(ref2);
        b2.set(ref2, { v: 2 }, { merge: true });
        await b2.commit();
        const s2 = await ref2.get();
        const d2 = s2.data() as DocumentData;
        expect(d2).toEqual({ v: 2 });
      });
    });

    //#endregion

    //#region BulkWriter

    describe('BulkWriter', () => {
      it('routes success/error correctly; no retry when onWriteError returns false', async () => {
        const good = col().doc('bw-route-good');
        const bad = col().doc('bw-route-bad'); // Will be updated with exists:true and should fail.

        const writer = Firestore.bulkWriter();

        let successCount = 0;
        let errorCount = 0;
        const successPaths: string[] = [];
        const errorPaths: string[] = [];

        writer.onWriteResult((ref, res) => {
          successCount++;
          successPaths.push(ref.path);
          expect(res.writeTime).toBeInstanceOf(Timestamp);
        });

        writer.onWriteError((err) => {
          errorCount++;
          errorPaths.push(err.documentRef.path);
          // Do not retry in this test
          return false;
        });

        const pOk = writer.set(good, { ok: true });
        const pFail = writer.update(bad, { nope: true }, { exists: true });

        writer.close();

        await pOk;
        await ExpectError.async(() => pFail, { code: Status.NOT_FOUND });

        expect(successCount).toBe(1);
        expect(errorCount).toBe(1);
        expect(successPaths).toEqual([good.path]);
        expect(errorPaths).toEqual([bad.path]);

        const [gs, bs] = await Promise.all([good.get(), bad.get()]);
        expect((gs.data() as DocumentData).ok).toBe(true);
        expect(bs.exists).toBe(false);
      });

      it('retries when onWriteError returns true; eventual success yields a single success callback', async () => {
        const target = col().doc('bw-retry-sequence');

        const writer = Firestore.bulkWriter();

        let successCount = 0;
        let errorCount = 0;
        let setEnqueued = false;

        writer.onWriteResult(() => {
          successCount++;
        });

        writer.onWriteError((err) => {
          if (err.documentRef.path === target.path) {
            errorCount++;
            // After the *first* failure, create the doc so the retry can succeed.
            if (!setEnqueued) {
              setEnqueued = true;
              writer.set(target, { s: 1 }, { merge: true });
            }
            // Allow retry of the update
            return true;
          }
          return false;
        });

        // 1) Start with an update that must fail (doc doesn't exist).
        writer.update(target, { u: 1 }, { exists: true });

        // 2) Force the first attempt to be sent now (so we see the error).
        await writer.flush();

        // 3) Drain all work (the retried update + the set).
        await writer.close();

        // Both logical writes should have succeeded in the end.
        expect(successCount).toBe(2);
        expect(errorCount).toBeGreaterThanOrEqual(1);

        const snap = await target.get();
        const d = snap.data() as DocumentData;
        expect(d).toEqual({ s: 1, u: 1 });
      });

      it('completion order is not guaranteed to match submission order; success fires once per op', async () => {
        const writer = Firestore.bulkWriter();

        const toMake = Array.from({ length: 12 }, (_, i) =>
          col().doc(`bw-order-${i + 1}`)
        );
        const submitted: string[] = [];
        const completed: string[] = [];

        writer.onWriteResult((ref) => {
          completed.push(ref.id);
        });

        for (const ref of toMake) {
          submitted.push(ref.id);
          writer.set(ref, { i: ref.id });
        }

        await writer.close();

        // All submitted ops must have exactly one success callback.
        expect(completed.length).toBe(submitted.length);
        // Same members, order not asserted.
        expect(new Set(completed)).toEqual(new Set(submitted));

        // Sanity: data exists.
        const snaps = await Promise.all(toMake.map((r) => r.get()));
        for (const s of snaps) {
          expect(s.exists).toBe(true);
        }
      });

      it('error callback payload shape: contains code, documentRef, and failedAttempts; success payload has Timestamp', async () => {
        const ok = col().doc('bw-shape-ok');
        const fail = col().doc('bw-shape-fail');

        const writer = Firestore.bulkWriter();

        let sawSuccessRef: string | undefined;
        let sawSuccessTime: Timestamp | undefined;
        let sampleError:
          | {
              code: number;
              documentRefPath: string;
              failedAttempts: number;
              message: string;
            }
          | undefined;

        writer.onWriteResult((ref, res) => {
          sawSuccessRef = ref.path;
          sawSuccessTime = res.writeTime;
        });

        writer.onWriteError((err) => {
          sampleError = {
            code: err.code,
            documentRefPath: err.documentRef.path,
            failedAttempts: err.failedAttempts,
            message: err.message,
          };
          // no retry
          return false;
        });

        const pOk = writer.set(ok, { a: 1 });
        const pFail = writer.update(fail, { b: 1 }, { exists: true });

        writer.close();
        await pOk;
        await ExpectError.async(() => pFail, {
          code: Status.NOT_FOUND,
          //   match: /Document does not exist/,
        });

        expect(typeof sawSuccessRef).toBe('string');
        expect(sawSuccessTime).toBeInstanceOf(Timestamp);

        expect(sampleError).toBeDefined();
        expect(typeof sampleError?.code).toBe('number');
        expect(typeof sampleError?.documentRefPath).toBe('string');
        expect(sampleError?.failedAttempts).toBeGreaterThanOrEqual(1);
        expect(typeof sampleError?.message).toBe('string');
      });

      // --- BulkWriter: deletes ---

      it('delete existing document: success fires and document is gone', async () => {
        const ref = col().doc('bw-del-existing');
        await ref.set({ a: 1 });

        const writer = Firestore.bulkWriter();

        let success = 0;
        let sawPath: string | undefined;

        writer.onWriteResult((r, res) => {
          success++;
          sawPath = r.path;
          expect(res.writeTime).toBeInstanceOf(Timestamp);
        });

        const p = writer.delete(ref);
        await writer.close();

        await p;
        expect(success).toBe(1);
        expect(sawPath).toBe(ref.path);

        const snap = await ref.get();
        expect(snap.exists).toBe(false);
      });

      it('delete missing without precondition succeeds (no-op) and triggers success callback', async () => {
        const ref = col().doc('bw-del-missing-no-pre');

        const writer = Firestore.bulkWriter();
        let success = 0;

        writer.onWriteResult(() => {
          success++;
        });

        const p = writer.delete(ref);
        await writer.close();

        await p;
        expect(success).toBe(1);

        const snap = await ref.get();
        expect(snap.exists).toBe(false);
      });

      it('delete missing with { exists:true } routes to error; retry after create then succeeds', async () => {
        const target = col().doc('bw-del-retry');

        const writer = Firestore.bulkWriter();

        let errorCount = 0;
        let successCount = 0;
        let created = false;

        writer.onWriteResult(() => {
          successCount++;
        });

        writer.onWriteError((err) => {
          if (err.documentRef.path === target.path) {
            errorCount++;
            // Create doc so the retried delete can succeed
            if (!created) {
              created = true;
              // enqueue a set; the retried delete will run after
              writer.set(target, { temp: true });
            }
            return true; // allow retry
          }
          return false;
        });

        // First attempt must fail (doc missing + exists:true)
        const p = writer.delete(target, { exists: true });

        // Force first send so we see the failure and enqueue the set
        await writer.flush();
        await writer.close();

        await p; // no throw in the end
        // Note: p resolves successfully after retry; the above ensures no error path

        expect(errorCount).toBeGreaterThanOrEqual(1);
        // Two successes: one for the set, one for the successful retry delete
        expect(successCount).toBe(2);

        const snap = await target.get();
        expect(snap.exists).toBe(false);
      });

      it('error payload for delete with { exists:true } includes code, documentRef, failedAttempts', async () => {
        const ref = col().doc('bw-del-shape');
        const writer = Firestore.bulkWriter();

        let sampleError:
          | {
              code: number;
              documentRefPath: string;
              failedAttempts: number;
              message: string;
            }
          | undefined;

        writer.onWriteError((err) => {
          sampleError = {
            code: err.code,
            documentRefPath: err.documentRef.path,
            failedAttempts: err.failedAttempts,
            message: err.message,
          };
          return false; // do not retry
        });

        const p = writer.delete(ref, { exists: true });
        writer.close();

        // await p;
        await ExpectError.async(() => p, { code: Status.NOT_FOUND });

        expect(sampleError).toBeDefined();
        expect(typeof sampleError?.code).toBe('number');
        expect(sampleError?.documentRefPath).toBe(ref.path);
        expect(sampleError?.failedAttempts).toBeGreaterThanOrEqual(1);
        expect(typeof sampleError?.message).toBe('string');
      });
    });

    // //#endregion
  });
}
