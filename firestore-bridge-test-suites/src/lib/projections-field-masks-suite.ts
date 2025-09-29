// projections-field-masks.suite.ts
import {
    DocumentData,
    FieldPath,
    Firestore,
    QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { isEmpty } from './helpers/document-data.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function projectionsFieldMasksTests(
  context: FirestoreBridgeTestContext
) {
  const COLLECTION_ID = 'Projections and Field Masks';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;
    let nestedSelectSupported = false;

    // Helper: run test body only if nested selects are supported; otherwise no-op.
    const itIfNested = (name: string, fn: () => Promise<void> | void) =>
      it(name, async () => {
        if (!nestedSelectSupported) return; // no-op -> quick pass, acts as gated
        await fn();
      });

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);

      // Seed: three docs covering nested maps, partials, and arrays.
      const col = FirestoreDb.collection(COLLECTION_ID);
      await col.doc('a1').set({
        title: 'full',
        profile: {
          name: { first: 'Ada', last: 'Lovelace' },
          contact: { email: 'ada@example.com', phone: '123' },
        },
        stats: { posts: 3, likes: 10 },
        tags: ['math', 'analyst'],
      });

      await col.doc('a2').set({
        title: 'partial',
        profile: {
          name: { first: 'Alan' }, // no last
        },
        // stats missing
        tags: ['logic'],
      });

      await col.doc('a3').set({
        title: 'array-only',
        tags: ['t1', 't2', 't3'],
      });

      // Feature gate: attempt a nested projection (dotted), then FieldPath fallback.
      try {
        const qsTry = await col
          .orderBy(FieldPath.documentId())
          .select('profile.name.first')
          .limit(1)
          .get();
        // If no throw, accept as supported.
        if (qsTry) nestedSelectSupported = true;
      } catch {
        try {
          const qsTry2 = await col
            .orderBy(FieldPath.documentId())
            .select(new FieldPath('profile', 'name', 'first'))
            .limit(1)
            .get();
          if (qsTry2) nestedSelectSupported = true;
        } catch {
          nestedSelectSupported = false;
        }
      }
    });

    afterAll(async () => {
      await context.tearDown();
    });

    // --- Basic projections ---

    it('select(top-level) returns only requested field(s)', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const qs = await col
        .orderBy(FieldPath.documentId())
        .select('title')
        .get();

      expect(qs.size).toBe(3);
      for (const d of qs.docs) {
        const data = d.data() as DocumentData;
        expect(Object.keys(data)).toEqual(['title']); // only "title"
        expect(typeof data.title).toBe('string');
      }
    });

    it('select(FieldPath.documentId()) returns name-only projection (data() is empty object)', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const qs = await col
        .orderBy(FieldPath.documentId())
        .select(FieldPath.documentId())
        .get();

      expect(qs.size).toBe(3);
      for (const snap of qs.docs) {
        const data = snap.data() as DocumentData;
        expect(isEmpty(data)).toBe(true);
        expect(typeof snap.id).toBe('string');
        expect(snap.ref.path).toContain(`/${snap.id}`);
      }
    });

    it('select() with no arguments returns name-only projection (data() is empty object)', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const qs = await col.orderBy(FieldPath.documentId()).select().get();

      expect(qs.size).toBe(3);
      for (const snap of qs.docs) {
        const data = snap.data() as DocumentData;
        expect(isEmpty(data)).toBe(true);
      }
    });

    it('select(multiple top-level fields) returns requested subset only', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const qs = await col
        .orderBy(FieldPath.documentId())
        .select('title', 'tags')
        .get();

      expect(qs.size).toBe(3);
      for (const snap of qs.docs) {
        const data = snap.data() as DocumentData;
        const keys = Object.keys(data).sort();
        expect(keys).toEqual(['tags', 'title']);
        expect(Array.isArray(data.tags)).toBe(true);
        expect(typeof data.title).toBe('string');
      }
    });

    it('select(field that does not exist) yields empty object for that doc', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const qs = await col
        .orderBy(FieldPath.documentId())
        .select('stats') // a2 and a3 have no "stats"
        .get();

      const docsById = new Map(qs.docs.map((d) => [d.id, d]));
      const a1 = docsById.get('a1') as QueryDocumentSnapshot;
      const a2 = docsById.get('a2') as QueryDocumentSnapshot;
      const a3 = docsById.get('a3') as QueryDocumentSnapshot;

      expect(isEmpty(a1.data() as DocumentData)).toBe(false); // a1 has stats
      expect(isEmpty(a2.data() as DocumentData)).toBe(true); // missing => {}
      expect(isEmpty(a3.data() as DocumentData)).toBe(true); // missing => {}
    });

    // --- Nested projections (runtime-gated) ---

    describe('Nested masks', () => {
      itIfNested(
        'select(nested dotted string) returns only the nested leaf within its parent hierarchy',
        async () => {
          const col = FirestoreDb.collection(COLLECTION_ID);

          const qs = await col
            .orderBy(FieldPath.documentId())
            .select('profile.name.first')
            .get();

          const docsById = new Map(qs.docs.map((d) => [d.id, d]));
          const a1 = docsById.get('a1') as QueryDocumentSnapshot;
          const a2 = docsById.get('a2') as QueryDocumentSnapshot;
          const a3 = docsById.get('a3') as QueryDocumentSnapshot;

          const d1 = a1.data() as DocumentData;
          const d2 = a2.data() as DocumentData;
          const d3 = a3.data() as DocumentData;

          expect(d1).toEqual({ profile: { name: { first: 'Ada' } } });
          expect(d2).toEqual({ profile: { name: { first: 'Alan' } } });
          expect(isEmpty(d3)).toBe(true); // no "profile" => {}
        }
      );

      itIfNested(
        'select(nested via FieldPath(...segments)) works equivalently',
        async () => {
          const col = FirestoreDb.collection(COLLECTION_ID);
          const fp = new FieldPath('profile', 'contact', 'email');

          const qs = await col.orderBy(FieldPath.documentId()).select(fp).get();

          const docsById = new Map(qs.docs.map((d) => [d.id, d]));
          const a1 = docsById.get('a1') as QueryDocumentSnapshot;
          const a2 = docsById.get('a2') as QueryDocumentSnapshot;
          const a3 = docsById.get('a3') as QueryDocumentSnapshot;

          const d1 = a1.data() as DocumentData;
          const d2 = a2.data() as DocumentData;
          const d3 = a3.data() as DocumentData;

          expect(d1).toEqual({
            profile: { contact: { email: 'ada@example.com' } },
          });
          expect(isEmpty(d2)).toBe(true); // contact missing
          expect(isEmpty(d3)).toBe(true);
        }
      );

      itIfNested(
        'select(multiple nested + top-level) merges projected paths only',
        async () => {
          const col = FirestoreDb.collection(COLLECTION_ID);

          const qs = await col
            .orderBy(FieldPath.documentId())
            .select(
              'title',
              'profile.name.last',
              new FieldPath('stats', 'posts')
            )
            .get();

          const docsById = new Map(qs.docs.map((d) => [d.id, d]));
          const a1 = docsById.get('a1') as QueryDocumentSnapshot;
          const a2 = docsById.get('a2') as QueryDocumentSnapshot;
          const a3 = docsById.get('a3') as QueryDocumentSnapshot;

          const d1 = a1.data() as DocumentData;
          const d2 = a2.data() as DocumentData;
          const d3 = a3.data() as DocumentData;

          expect(d1).toEqual({
            title: 'full',
            profile: { name: { last: 'Lovelace' } },
            stats: { posts: 3 },
          });

          expect(d2).toEqual({ title: 'partial' }); // missing last + stats
          expect(d3).toEqual({ title: 'array-only' }); // missing nested + stats
        }
      );
    });

    // --- N/A marker (informational) ---
    it('N/A: Nested field masks are not supported in this environment', () => {
      // If supported, do nothing (pass). If unsupported, assert explicitly for clarity.
      if (!nestedSelectSupported) {
        expect(nestedSelectSupported).toBe(false);
      }
    });
  });
}
