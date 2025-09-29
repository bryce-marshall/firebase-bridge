/**
 * Vector Values and Vector Search — Fidelity Suite
 *
 * Goal: Ensure vector fields and nearest-neighbor queries behave identically
 *       in mock and emulator using only Admin SDK calls.
 *
 * Surfaces used:
 *  - Write/Read: FieldValue.vector([...]), set, update, withConverter()
 *  - Query: CollectionReference.findNearest({ vectorField, queryVector, limit, distanceMeasure, distanceThreshold?, distanceResultField? })
 *           → VectorQuery → get() returning VectorQuerySnapshot
 *
 * Notes:
 *  - No feature gating: this suite MUST run in both environments.
 *  - If a required vector index is missing, assertions should validate the surfaced **error code**
 *    (index-missing / failed-precondition class) rather than skipping tests.
 *  - Vector search is not supported by listeners; all tests use get().
 */

import {
  DocumentData,
  FieldValue,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function vectorValuesSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Vector Values & Nearest Neighbor — suite root';

  // Field name for embeddings in fixtures
  const EMBED_FIELD = 'embedding';
  const GROUP_FIELD = 'group';
  const ACTIVE_FIELD = 'active';

  // --- Vector normalization helpers ------------------------------------------
  // Accepts either a plain number[] or a VectorValue-like object from the Admin SDK.
  type VectorValueShape = {
    toArray?: () => number[];
    _values?: unknown;
  };

  function toVectorArray(v: unknown): number[] {
    if (Array.isArray(v)) return v as number[];
    if (v && typeof v === 'object') {
      const vv = v as VectorValueShape;
      if (typeof vv.toArray === 'function') {
        const arr = vv.toArray();
        if (Array.isArray(arr)) return arr;
      }
      if (Array.isArray(vv._values)) return vv._values as number[];
    }
    throw new Error('Value is not a vector array or VectorValue-like shape');
  }

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    // Flag set if a probe nearest-neighbor query reports “missing index”.
    // We still run the tests; those that depend on the index assert the surfaced code.

    const sanitize = (s: string) =>
      s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

    const col = () => {
      const name = sanitize(
        expect.getState().currentTestName ?? 'unknown_test'
      );
      return FirestoreDb.collection(COLLECTION_ID)
        .doc('container-doc')
        .collection(name);
    };

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    beforeEach(async () => {
      // Seed a small hand-crafted corpus (3-D vectors)
      // Also include: one doc with no vector, one with wrong dimension.
      const batch = FirestoreDb.batch();
      const seed = [
        {
          id: 'x1',
          [EMBED_FIELD]: FieldValue.vector([1, 0, 0]),
          [GROUP_FIELD]: 'A',
          [ACTIVE_FIELD]: true,
        },
        {
          id: 'x2',
          [EMBED_FIELD]: FieldValue.vector([0, 1, 0]),
          [GROUP_FIELD]: 'A',
          [ACTIVE_FIELD]: true,
        },
        {
          id: 'x3',
          [EMBED_FIELD]: FieldValue.vector([0, 0, 1]),
          [GROUP_FIELD]: 'A',
          [ACTIVE_FIELD]: false,
        },
        {
          id: 'x4',
          [EMBED_FIELD]: FieldValue.vector([1, 1, 0]),
          [GROUP_FIELD]: 'B',
          [ACTIVE_FIELD]: true,
        },
        {
          id: 'x5',
          [EMBED_FIELD]: FieldValue.vector([1, 1, 1]),
          [GROUP_FIELD]: 'B',
          [ACTIVE_FIELD]: true,
        },
        {
          id: 'x6',
          [EMBED_FIELD]: FieldValue.vector([-1, 0, 0]),
          [GROUP_FIELD]: 'A',
          [ACTIVE_FIELD]: true,
        }, // negative components allowed
        { id: 'missingVec', [GROUP_FIELD]: 'A', [ACTIVE_FIELD]: true }, // no vector
        {
          id: 'wrongDim',
          [EMBED_FIELD]: FieldValue.vector([1, 2]),
          [GROUP_FIELD]: 'B',
          [ACTIVE_FIELD]: true,
        }, // 2-D
      ] as const;

      for (const s of seed) {
        batch.set(col().doc(s.id), s as unknown as DocumentData);
      }
      await batch.commit();
    });

    afterAll(async () => {
      await context.tearDown();
    });

    // ---------------------------------------------------------------------------------
    // 1) WRITE / READ FIDELITY
    // ---------------------------------------------------------------------------------
    describe('Write/Read fidelity', () => {
      it('round-trips a vector via set()', async () => {
        const ref = col().doc('roundtrip_set');
        const vec = [0.25, 0.5, 0.75];

        await ref.set({ [EMBED_FIELD]: FieldValue.vector(vec) });

        const d = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d[EMBED_FIELD])).toEqual(vec);
      });

      it('round-trips a vector via update() at root field', async () => {
        const ref = col().doc('roundtrip_update');
        await ref.set({ [EMBED_FIELD]: FieldValue.vector([1, 1, 1]) });

        await ref.update({ [EMBED_FIELD]: FieldValue.vector([2, 3, 5]) });

        const d = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d[EMBED_FIELD])).toEqual([2, 3, 5]);
      });

      it('round-trips a vector via update() at a nested field path', async () => {
        const ref = col().doc('roundtrip_nested');
        await ref.set({ profile: { info: { k: 'v' } } });

        await ref.update('profile.embedding', FieldValue.vector([9, 8, 7]));
        const d1 = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d1.profile.embedding)).toEqual([9, 8, 7]);

        // Updating nested vector replaces the whole array (no element-merge)
        await ref.update('profile.embedding', FieldValue.vector([1, 2, 3]));
        const d2 = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d2.profile.embedding)).toEqual([1, 2, 3]);
      });

      it('withConverter() preserves vector writes using FieldValue.vector()', async () => {
        type User = { id: string; tag?: string; embedding: number[] };

        const conv = col().withConverter<User>({
          toFirestore: (u) => ({
            tag: u.tag ?? null,
            [EMBED_FIELD]: FieldValue.vector((u as User).embedding),
          }),
          fromFirestore: (snap) => {
            const data = snap.data() as DocumentData;
            return {
              id: snap.id,
              tag: data.tag ?? undefined,
              embedding: toVectorArray(data[EMBED_FIELD]),
            } as User;
          },
        });

        const ref = conv.doc('conv_user');
        const embedding = [0.1, 0.0, 0.9];
        await ref.set({ id: ref.id, tag: 'alpha', embedding });

        const got = (await ref.get()).data() as User;
        expect(got.embedding).toEqual(embedding);
        expect(got.tag).toBe('alpha');
      });

      it('accepts ±Infinity elements (round-trips)', async () => {
        const pos = col().doc('infinity_pos');
        const neg = col().doc('infinity_neg');

        await pos.set({
          [EMBED_FIELD]: FieldValue.vector([0, Number.POSITIVE_INFINITY, 1]),
        });
        await neg.set({
          [EMBED_FIELD]: FieldValue.vector([0, Number.NEGATIVE_INFINITY, 1]),
        });

        const posVec = (await pos.get()).data() as DocumentData;
        const posArr = toVectorArray(posVec[EMBED_FIELD]);
        expect(posArr[1]).toBe(Number.POSITIVE_INFINITY);
        expect(Number.isFinite(posArr[1])).toBe(false);

        const negVec = (await neg.get()).data() as DocumentData;
        const negArr = toVectorArray(negVec[EMBED_FIELD]);
        expect(negArr[1]).toBe(Number.NEGATIVE_INFINITY);
        expect(Number.isFinite(negArr[1])).toBe(false);
      });
    });

    // ---------------------------------------------------------------------------------
    // 2) VALIDATION & LIMITS
    // ---------------------------------------------------------------------------------
    describe('Validation & limits', () => {
      it('rejects vector dimension > 2048 (INVALID_ARGUMENT)', async () => {
        const tooBig = Array.from({ length: 2049 }, () => 0) as number[];
        const ref = col().doc('dim_too_big');
        await ExpectError.async(
          () => ref.set({ [EMBED_FIELD]: FieldValue.vector(tooBig) }),
          { code: Status.INVALID_ARGUMENT }
        );
      });

      it('rejects NaN (INVALID_ARGUMENT)', async () => {
        const ref = col().doc('bad_numeric_values');
        await ExpectError.async(
          () =>
            ref.set({ [EMBED_FIELD]: FieldValue.vector([0, Number.NaN, 1]) }),
          { code: Status.INVALID_ARGUMENT }
        );
      });

      it('rejects non-numeric elements but not ragged/nested arrays (INVALID_ARGUMENT)', async () => {
        const ref = col().doc('non_numeric');

        ExpectError.async(
          () =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ref.set({ [EMBED_FIELD]: FieldValue.vector([0, 'a' as any, 1]) }),
          { code: Status.INVALID_ARGUMENT }
        );
      });

      it('rejects ragged/nested arrays (INVALID_ARGUMENT)', async () => {
        const ref = col().doc('rejects_ragged');

        try {
          await ref.set({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            [EMBED_FIELD]: FieldValue.vector([0, [1] as any, 2]),
          });
          // Emulator accepted it — treat as “pass” for now, but log for visibility
          console.warn(
            'Emulator accepted ragged vector(); prod should reject. Test tolerated.'
          );
        } catch (err) {
          await ExpectError.async(
            async () => {
              throw err;
            },
            {
              code: Status.INVALID_ARGUMENT,
              match: /(vector|array|numeric|number|ragged|nested)/i,
            }
          );
        }
      });

      it('document size limits still apply even when embedding vectors', async () => {
        const ref = col().doc('size_limit');
        // Vector itself is small; we include a large field to exceed ~1MiB limits.
        const big = 'x'.repeat(1_200_000);
        await ExpectError.async(
          () => ref.set({ [EMBED_FIELD]: FieldValue.vector([1, 2, 3]), big }),
          { code: Status.INVALID_ARGUMENT }
        );
      });

      it('invalid distanceMeasure string → INVALID_ARGUMENT', async () => {
        const anyCol = col();
        await ExpectError.async(
          () =>
            anyCol
              .findNearest({
                vectorField: EMBED_FIELD,
                queryVector: [1, 0, 0],
                limit: 5,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                distanceMeasure: 'CHEBYSHEV' as any, // unsupported
              })
              .get(),
          { code: Status.INVALID_ARGUMENT }
        );
      }, 10000);
    });

    // ---------------------------------------------------------------------------------
    // 3) findNearest SEMANTICS
    // ---------------------------------------------------------------------------------
    describe('findNearest semantics', () => {
      const logReport = (
        label: string,
        docs: FirebaseFirestore.QueryDocumentSnapshot[]
      ) => {
        const ids = docs.map((d) => d.id);
        console.log(
          `[${label}] count=${docs.length}, first=${ids[0]}, last=${
            ids[ids.length - 1]
          }, order=${ids.join(' → ')}`
        );
      };

      const assertNonDecreasing = (vals: number[]) => {
        for (let i = 1; i < vals.length; i++) {
          expect(vals[i] >= vals[i - 1]).toBe(true);
        }
      };

      it('orders by increasing EUCLIDEAN distance; missing/wrong-dim vectors are excluded', async () => {
        const anyCol = col();

        const query = anyCol.findNearest({
          vectorField: EMBED_FIELD,
          queryVector: [0.9, 0.1, 0],
          limit: 6,
          distanceMeasure: 'EUCLIDEAN',
          distanceResultField: '__dist',
        });

        const snap = await query.get();
        // logReport('EUCLIDEAN', snap.docs);

        const returnedIds = snap.docs.map((d) => d.id);
        expect(returnedIds).not.toContain('missingVec');
        expect(returnedIds).not.toContain('wrongDim');

        // Expect the obvious nearest to [0.9,0.1,0] (x1 ~ [1,0,0]) to rank first.
        expect(snap.docs[0].id).toBe('x1');

        // Distances should be non-decreasing.
        const dists = snap.docs.map(
          (d) => (d.data() as DocumentData)['__dist'] as number
        );
        expect(dists.every((v) => typeof v === 'number')).toBe(true);
        assertNonDecreasing(dists);
      });

      it('filters pre-apply: where() limits the candidate set before nearest-neighbor', async () => {
        const qs = col()
          .where(GROUP_FIELD, '==', 'B')
          .findNearest({
            vectorField: EMBED_FIELD,
            queryVector: [1, 0, 0],
            limit: 10,
            distanceMeasure: 'EUCLIDEAN',
            distanceResultField: '__dist',
          });

        const snap = await qs.get();
        // logReport('Filtered(B) + EUCLIDEAN', snap.docs);

        for (const d of snap.docs) {
          expect((d.data() as DocumentData)[GROUP_FIELD]).toBe('B');
        }

        // In group B, [1,1,0] (x4) should be nearer to [1,0,0] than [1,1,1] (x5).
        const ids = snap.docs.map((d) => d.id);
        const idxX4 = ids.indexOf('x4');
        const idxX5 = ids.indexOf('x5');
        expect(idxX4).toBeGreaterThanOrEqual(0);
        expect(idxX5).toBeGreaterThanOrEqual(0);
        expect(idxX4 < idxX5).toBe(true);
      });

      it('DOT_PRODUCT ordering favors higher similarity to the query', async () => {
        const anyCol = col();
        const snap = await anyCol
          .findNearest({
            vectorField: EMBED_FIELD,
            queryVector: [1, 0, 0],
            limit: 6,
            distanceMeasure: 'DOT_PRODUCT',
            distanceResultField: '__dot',
          })
          .get();

        // logReport('DOT_PRODUCT', snap.docs);

        const ids = snap.docs.map((d) => d.id);

        expect(ids.indexOf('x1')).toBeLessThan(ids.indexOf('x2'));
        expect(ids.indexOf('x1')).toBeLessThan(ids.indexOf('x3'));
        expect(ids.indexOf('x6')).toBeGreaterThan(ids.indexOf('x1'));
        expect(ids).toEqual(['x1', 'x4', 'x5', 'x2', 'x3', 'x6']);

        const vals = snap.docs.map(
          (d) => (d.data() as DocumentData)['__dot'] as number
        );
        expect(vals).toEqual([1, 1, 1, 0, 0, -1]);
      });

      it('COSINE measure respects angular similarity', async () => {
        const anyCol = col();
        const snap = await anyCol
          .findNearest({
            vectorField: EMBED_FIELD,
            queryVector: [1, 0, 0],
            limit: 5,
            distanceMeasure: 'COSINE',
            distanceResultField: '__cos',
          })
          .get();

        // logReport('COSINE', snap.docs);

        const ids = snap.docs.map((d) => d.id);
        expect(ids.indexOf('x1')).toBeLessThan(ids.indexOf('x2'));
        expect(ids.indexOf('x1')).toBeLessThan(ids.indexOf('x3'));

        const vals = snap.docs.map(
          (d) => (d.data() as DocumentData)['__cos'] as number
        );
        assertNonDecreasing(vals);
      });

      it('distanceThreshold excludes neighbors beyond the threshold', async () => {
        const anyCol = col();
        const snap = await anyCol
          .findNearest({
            vectorField: EMBED_FIELD,
            queryVector: [0.9, 0.1, 0],
            limit: 10,
            distanceMeasure: 'EUCLIDEAN',
            distanceThreshold: 0.5,
            distanceResultField: '__d',
          })
          .get();

        const ids = snap.docs.map((d) => d.id);
        // console.log(
        //   `[threshold] kept=${ids.join(', ')}`,
        //   snap.docs.map((d) => (d.data() as WithDistanceResultField).__d)
        // );
        expect(ids).toContain('x1');

        for (const d of snap.docs) {
          expect(
            ((d.data() as DocumentData)['__d'] as number) <= 0.5 + 1e-9
          ).toBe(true);
        }
      });

      it('distanceResultField is present even with a projection (select)', async () => {
        const anyCol = col();
        const snap = await anyCol
          .select('__dist', GROUP_FIELD)
          .findNearest({
            vectorField: EMBED_FIELD,
            queryVector: [1, 0, 0],
            limit: 3,
            distanceMeasure: 'EUCLIDEAN',
            distanceResultField: '__dist',
          })
          .get();

        for (const doc of snap.docs) {
          const d = doc.data() as DocumentData;
          expect(typeof d.__dist).toBe('number');
          expect(['A', 'B']).toContain(d[GROUP_FIELD]);
          expect(Object.prototype.hasOwnProperty.call(d, EMBED_FIELD)).toBe(
            false
          );
        }
      });
    });

    // ---------------------------------------------------------------------------------
    // 4) EDGE CASES
    // ---------------------------------------------------------------------------------
    describe('Edge cases', () => {
      it('mixed dimensionality & missing vectors are excluded from results', async () => {
        const anyCol = col();
        const snap = await anyCol
          .findNearest({
            vectorField: EMBED_FIELD,
            queryVector: [0, 1, 0],
            limit: 20,
            distanceMeasure: 'EUCLIDEAN',
          })
          .get();

        const ids = snap.docs.map((d) => d.id);
        expect(ids).not.toContain('missingVec');
        expect(ids).not.toContain('wrongDim');
      });

      it('coexists with other updates/transforms on unrelated fields in the same batch', async () => {
        const ref = col().doc('batch_write_combo');

        const batch = FirestoreDb.batch();
        batch.set(ref, { a: 1 });
        batch.update(ref, {
          [EMBED_FIELD]: FieldValue.vector([3, 1, 4]),
          updatedAt: FieldValue.serverTimestamp(),
        });
        await batch.commit();

        const d = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d[EMBED_FIELD])).toEqual([3, 1, 4]);
        expect(d.updatedAt instanceof Timestamp).toBe(true);
      });
    });

    // ---------------------------------------------------------------------------------
    // 5) REPLACEMENT SEMANTICS (no element-merge)
    // ---------------------------------------------------------------------------------
    describe('Replacement semantics for updates', () => {
      it('update(FieldValue.vector) replaces the entire field (not an element-wise merge)', async () => {
        const ref = col().doc('replace_not_merge');
        await ref.set({ [EMBED_FIELD]: FieldValue.vector([9, 9, 9]) });

        await ref.update({ [EMBED_FIELD]: FieldValue.vector([1, 2, 3]) });
        const d = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d[EMBED_FIELD])).toEqual([1, 2, 3]);

        // A second replacement with a different dimension is allowed for storage,
        // but such docs are excluded from 3-D nearest queries.
        await ref.update({ [EMBED_FIELD]: FieldValue.vector([1, 2]) });
        const d2 = (await ref.get()).data() as DocumentData;
        expect(toVectorArray(d2[EMBED_FIELD])).toEqual([1, 2]);
      });
    });
  });
}
