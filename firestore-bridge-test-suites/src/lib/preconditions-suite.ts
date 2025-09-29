// preconditions-suite.ts
import {
  DocumentData,
  DocumentReference,
  Firestore,
  Timestamp,
  WriteBatch,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function preconditionSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Preconditions (exists & updateTime)';

  describe(COLLECTION_ID, () => {
    let db!: Firestore;

    beforeAll(async () => {
      db = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    function docRef(id: string): DocumentReference<DocumentData> {
      return db.collection(COLLECTION_ID).doc(id);
    }

    describe('exists preconditions', () => {
      it('set-equivalent (exists:false) is enforced via create(); ALREADY_EXISTS when doc already exists', async () => {
        const r = docRef('exists-create-a');
        await r.create({ a: 1 });

        await ExpectError.async(() => r.create({ a: 2 }), {
          code: Status.ALREADY_EXISTS,
        });

        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBe(1);
      });

      it('update with exists:true fails if doc does not exist; succeeds once created', async () => {
        const r = docRef('exists-update-a');

        await ExpectError.async(() => r.update({ a: 1 }, { exists: true }), {
          code: Status.NOT_FOUND,
        });

        await r.set({ a: 1 });
        await r.update({ a: 2 }, { exists: true });

        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBe(2);
      });

      it('delete with exists:true fails if missing; succeeds when present', async () => {
        const r = docRef('exists-delete-a');

        await ExpectError.async(() => r.delete({ exists: true }), {
          code: Status.NOT_FOUND,
        });

        await r.set({ a: 1 });
        await r.delete({ exists: true });

        const snap = await r.get();
        expect(snap.exists).toBe(false);
      });

      it('update with exists:false is rejected (cannot require non-existence for an update)', async () => {
        const r = docRef('exists-update-invalid');
        await r.set({ a: 1 });

        await ExpectError.sync(() => r.update({ a: 2 }, { exists: false }), {
          match:
            /Value for argument "preconditionOrValues" is not a valid precondition\. "exists" is not allowed to have the value false \(allowed values: true\)/,
        });

        const snap = await r.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBe(1);
      });

      it('delete with exists:false is rejected (cannot require non-existence for a delete operation)', async () => {
        const r = docRef('exists-delete-invalid');
        await r.set({ a: 1 });

        await ExpectError.async(() => r.delete({ exists: false }), {
          code: Status.ALREADY_EXISTS,
        });

        const snap = await r.get();
        expect(snap.exists).toBe(true);
      });
    });

    describe('lastUpdateTime preconditions (equality only)', () => {
      it('set with lastUpdateTime equal to current updateTime succeeds; mismatched fails', async () => {
        const r = docRef('lut-set-a');

        await r.set({ v: 1 });
        const base = await r.get();
        const t0 = base.updateTime as Timestamp;

        await r.update({ v: 2 }, { lastUpdateTime: t0 });

        const after = await r.get();
        const t1 = after.updateTime as Timestamp;
        expect((after.data() as DocumentData).v).toBe(2);
        expect(t1).toBeDefined();

        await ExpectError.async(
          () => r.update({ v: 3 }, { lastUpdateTime: t0 }),
          {
            code: Status.FAILED_PRECONDITION,
          }
        );

        const snap = await r.get();
        expect((snap.data() as DocumentData).v).toBe(2);
      });

      it('update with lastUpdateTime equality works; stale timestamp rejected', async () => {
        const r = docRef('lut-update-a');
        await r.set({ count: 0 });

        const s0 = await r.get();
        const t0 = s0.updateTime as Timestamp;

        await r.update({ count: 1 }, { lastUpdateTime: t0 });

        const s1 = await r.get();
        const t1 = s1.updateTime as Timestamp;
        expect((s1.data() as DocumentData).count).toBe(1);

        await ExpectError.async(
          () => r.update({ count: 2 }, { lastUpdateTime: t0 }),
          { code: Status.FAILED_PRECONDITION }
        );

        await r.update({ count: 2 }, { lastUpdateTime: t1 });
        const s2 = await r.get();
        expect((s2.data() as DocumentData).count).toBe(2);
      });

      it('delete with lastUpdateTime equality works; stale timestamp rejected', async () => {
        const r = docRef('lut-delete-a');
        await r.set({ active: true });

        const s0 = await r.get();
        const t0 = s0.updateTime as Timestamp;

        await r.delete({ lastUpdateTime: t0 });

        await r.set({ active: true });
        const s1 = await r.get();
        const t1 = s1.updateTime as Timestamp;

        await ExpectError.async(() => r.delete({ lastUpdateTime: t0 }), {
          code: Status.FAILED_PRECONDITION,
        });

        await r.delete({ lastUpdateTime: t1 });
        const s2 = await r.get();
        expect(s2.exists).toBe(false);
      });
    });

    describe('Mixed preconditions in batched writes vs BulkWriter', () => {
      it('WriteBatch is atomic: any failed precondition rejects the whole commit and applies nothing', async () => {
        const a = docRef('batch-atomic-a');
        const b = docRef('batch-atomic-b');
        await a.set({ n: 0 });
        await b.set({ n: 0 });

        const aSnap = await a.get();
        const aTime = aSnap.updateTime as Timestamp;

        const bStale = await b.get();
        const bTimeStale = bStale.updateTime as Timestamp;
        await b.update({ n: 1 }); // advance b so bTimeStale becomes stale

        const batch: WriteBatch = db.batch();
        batch.update(a, { n: 1 }, { lastUpdateTime: aTime }); // valid
        batch.update(b, { n: 2 }, { lastUpdateTime: bTimeStale }); // stale

        await ExpectError.async(() => batch.commit(), {
          code: Status.FAILED_PRECONDITION,
        });

        const [aAfter, bAfter] = await Promise.all([a.get(), b.get()]);
        expect((aAfter.data() as DocumentData).n).toBe(0); // unchanged
        expect((bAfter.data() as DocumentData).n).toBe(1); // unchanged from the manual advance
      });

      it('BulkWriter is non-atomic: one write can succeed while another fails its precondition', async () => {
        const a = docRef('bulkwriter-mixed-a');
        const b = docRef('bulkwriter-mixed-b');
        await a.set({ n: 0 });
        await b.set({ n: 0 });

        const aSnap = await a.get();
        const aTime = aSnap.updateTime as Timestamp;

        const bStale = await b.get();
        const bTimeStale = bStale.updateTime as Timestamp;
        await b.update({ n: 1 }); // make bTimeStale stale

        const bw = db.bulkWriter();
        const results: { ok: string[]; err: string[] } = { ok: [], err: [] };

        await new Promise<void>((resolve) => {
          bw.update(a, { n: 2 }, { lastUpdateTime: aTime })
            .then(() => results.ok.push('a'))
            .catch((e) => results.err.push(`a:${e?.code ?? e?.message}`));

          bw.update(b, { n: 2 }, { lastUpdateTime: bTimeStale })
            .then(() => results.ok.push('b'))
            .catch((e) => results.err.push(`b:${e?.code ?? e?.message}`));

          bw.close().then(() => resolve());
        });

        expect(results.ok).toContain('a');
        expect(results.err.find((m) => m.startsWith('b:'))).toBeDefined();

        const [aAfter, bAfter] = await Promise.all([a.get(), b.get()]);
        expect((aAfter.data() as DocumentData).n).toBe(2); // succeeded
        expect((bAfter.data() as DocumentData).n).toBe(1); // failed precondition
      });
    });
  });
}
