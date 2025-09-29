import {
  CollectionReference,
  DocumentData,
  Firestore,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

/**
 * Limits & Bounds — Admin SDK fidelity tests
 *
 * Scope:
 *  - Enforce 500‑write batch limit
 *  - Validate document size / field depth error codes
 *  - Verify query truncation / limits (limit, limitToLast)
 */
export function limitsAndBoundsSuite(context: FirestoreBridgeTestContext) {
  // Unique root collection name ensures no collisions across emulator runs
  const COLLECTION_ID = 'Limits & Bounds — Test suite root collection';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    const col = () => {
      const name = expect.getState().currentTestName ?? 'unknown_test';
      return FirestoreDb.collection(COLLECTION_ID)
        .doc('container-doc')
        .collection(name);
    };
    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    const deep = (levels: number, last?: unknown) => {
      const root: Record<string, unknown> = {};
      let cursor: Record<string, unknown> = root;
      for (let i = 0; i < levels; i++) {
        const next: Record<string, unknown> = {};
        cursor.m = next;
        cursor = next;
      }
      if (last) {
        cursor.m = last;
      }

      return root;
    };

    // ---------- 500‑write batch limit ----------

    it('WriteBatch: up to 500 writes commit successfully', async () => {
      const batch = FirestoreDb.batch();

      for (let i = 0; i < 500; i++) {
        const ref = col().doc(`batch-ok-${i}`);
        batch.set(ref, { i });
      }

      const results = await batch.commit();
      expect(results.length).toBe(500);

      // Spot‑check a couple of documents exist
      const snapA = await col().doc('batch-ok-0').get();
      const snapZ = await col().doc('batch-ok-499').get();
      expect(snapA.exists).toBe(true);
      expect(snapZ.exists).toBe(true);
    });

    it('WriteBatch: up to 500 writes commit successfully', async () => {
      const batch = FirestoreDb.batch();

      for (let i = 0; i < 500; i++) {
        const ref = col().doc(`batch-ok-${i}`);
        batch.set(ref, { i });
      }

      const results = await batch.commit();
      expect(results.length).toBe(500);

      // Spot‑check a couple of documents exist
      const snapA = await col().doc('batch-ok-0').get();
      const snapZ = await col().doc('batch-ok-499').get();
      expect(snapA.exists).toBe(true);
      expect(snapZ.exists).toBe(true);
    });

    it('WriteBatch: can commit more than 500 writes (limit removed Mar 29, 2023)', async () => {
      const batch = FirestoreDb.batch();
      for (let i = 0; i < 601; i++) {
        batch.set(col().doc(`batch-601-${i}`), { i });
      }

      const results = await batch.commit();
      expect(results.length).toBe(601);

      // Spot‑check last write materialized
      const last = await col().doc('batch-601-600').get();
      expect(last.exists).toBe(true);
    });

    // ---------- Document size and field depth limits ----------

    it('rejects documents with nested maps deeper than 20 levels (INVALID_ARGUMENT)', async () => {
      // Build nested { m: { m: { ... } } } depth = 21
      //   const deep = (levels: number) => {
      //     const root: Record<string, unknown> = {};
      //     let cursor: Record<string, unknown> = root;
      //     for (let i = 0; i < levels; i++) {
      //       const next: Record<string, unknown> = {};
      //       cursor.m = next;
      //       cursor = next;
      //     }
      //     return root;
      //   };

      const tooDeep = deep(21); // > 20
      const ref = col().doc('too-deep');

      await ExpectError.async(() => ref.set(tooDeep), {
        code: Status.INVALID_ARGUMENT,
        match: /Property m contains an invalid nested entity./i,
      });
    });

    it('accepts documents with nested maps at 20 levels deep', async () => {
      // Build nested { m: { m: { ... } } } depth = 20
      const maxDepth = deep(20);
      const ref = col().doc('max-depth');
      await ref.set(maxDepth);
    });

    it("accepts documents with nested maps at 20 levels deep (doesn't count non-maps) ", async () => {
      const maxDepth = deep(19, [1, 2, 3]);
      const ref = col().doc('max-depth');
      await ref.set(maxDepth);
    });

    it('rejects documents with nested maps deeper than 20 levels (INVALID_ARGUMENT)', async () => {
      // Build nested { m: { m: { ... } } } depth = 21

      const tooDeep = deep(21); // > 20
      const ref = col().doc('too-deep');

      await ExpectError.async(() => ref.set(tooDeep), {
        code: Status.INVALID_ARGUMENT,
        match: /Property m contains an invalid nested entity./i,
      });
    });

    it('rejects documents with nested maps deeper than 20 levels counts array (INVALID_ARGUMENT)', async () => {
      const tooDeep = deep(19, [1, {}, 3]); // > 20
      const ref = col().doc('prop-at-max-depth');
      await ExpectError.async(() => ref.set(tooDeep), {
        code: Status.INVALID_ARGUMENT,
        match: /Property m contains an invalid nested entity./i,
      });
    });

    it('rejects documents with nested maps deeper than 21 levels (client rejects)', async () => {
      const tooDeep = deep(22);
      const ref = col().doc('prop-at-max-depth');
      await ExpectError.sync(() => ref.set(tooDeep), {
        match:
          /Value for argument "data" is not a valid Firestore document. Input object is deeper than 20 levels or contains a cycle./i,
      });
    });

    it('rejects documents exceeding ~1 MiB serialized size - single prop (INVALID_ARGUMENT)', async () => {
      // Ensure comfortably above 1 MiB to avoid edge accounting nuances
      const big = 'x'.repeat(1_200_000);
      const ref = col().doc('too-big');

      await ExpectError.async(() => ref.set({ big }), {
        code: Status.INVALID_ARGUMENT,
        match: /(?:invalid nested entity|1048(?:576|487)\s*bytes)/i,
      });
    });

    it('rejects documents exceeding ~1 MiB serialized size - nested prop (INVALID_ARGUMENT)', async () => {
      // Ensure comfortably above 1 MiB to avoid edge accounting nuances
      const big = 'x'.repeat(1_200_000);
      const ref = col().doc('too-big');

      await ExpectError.async(
        () => ref.set({ a: 0, b: 1, parent: { child: big } }),
        {
          code: Status.INVALID_ARGUMENT,
          match: /(?:invalid nested entity|1048(?:576|487)\s*bytes)/i,
        }
      );
    });

    it('rejects documents exceeding ~1 MiB serialized size - multiple props (INVALID_ARGUMENT)', async () => {
      // Ensure comfortably above 1 MiB to avoid edge accounting nuances
      const big = 'x'.repeat(600_000);
      const ref = col().doc('too-big');

      await ExpectError.async(() => ref.set({ bigX: big, bigY: big }), {
        code: Status.INVALID_ARGUMENT,
        match: /(?:invalid nested entity|1048(?:576|487)\s*bytes)/i,
      });
    });

    it('rejects documents exceeding ~1 MiB serialized size - multiple props nested (INVALID_ARGUMENT)', async () => {
      // Ensure comfortably above 1 MiB to avoid edge accounting nuances
      const big = 'x'.repeat(600_000);
      const ref = col().doc('too-big');

      await ExpectError.async(
        () => ref.set({ parent: { bigX: big, bigY: big } }),
        {
          code: Status.INVALID_ARGUMENT,
          match: /(?:invalid nested entity|1048(?:576|487)\s*bytes)/i,
        }
      );
    });

    // ---------- Query truncation / limits ----------

    describe('query limits and truncation', () => {
      async function seed(): Promise<CollectionReference> {
        // Seed a small ordered range only once for this sub‑suite
        const c = col();
        const batch = FirestoreDb.batch();
        for (let i = 1; i <= 10; i++) {
          batch.set(c.doc(`q-${i.toString().padStart(2, '0')}`), { x: i });
        }
        await batch.commit();

        return c;
      }

      it('limit(0) is ignored (returns all docs)', async () => {
        const c = await seed();
        const qs = await c.orderBy('x', 'asc').limit(0).get();
        expect(qs.size).toBe(10);

        const values = qs.docs.map((d) => (d.data() as DocumentData).x);
        expect(values).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      });

      it('limit(n) returns at most n documents in order', async () => {
        const c = await seed();
        const qs = await c.orderBy('x', 'asc').limit(3).get();
        expect(qs.size).toBe(3);

        const values = qs.docs.map((d) => (d.data() as DocumentData).x);
        expect(values).toEqual([1, 2, 3]);
      });

      it('limitToLast requires at least one orderBy (FAILED_PRECONDITION)', async () => {
        const c = await seed();
        const q = c.limitToLast(3);
        await ExpectError.async(() => q.get(), {
          // code is not preset,
          match:
            /limitToLast\(\) queries require specifying at least one orderBy\(\) clause./i,
        });
      });

      it('limitToLast(n) with orderBy returns the last n documents in ascending order', async () => {
        const c = await seed();
        const qs = await c.orderBy('x', 'asc').limitToLast(3).get();
        expect(qs.size).toBe(3);

        const values = qs.docs.map((d) => (d.data() as DocumentData).x);
        expect(values).toEqual([8, 9, 10]);
      });

      it('negative limits are rejected (INVALID_ARGUMENT)', async () => {
        const c = await seed();
        await ExpectError.async(() => c.orderBy('x', 'asc').limit(-1).get(), {
          code: Status.INVALID_ARGUMENT,
          match: /limit is negative/i,
        });
      }, 10000); // The test tends to be long-running on the emulator
    });
  });
}
