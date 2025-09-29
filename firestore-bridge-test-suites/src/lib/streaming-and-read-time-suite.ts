import { Firestore, Timestamp } from 'firebase-admin/firestore';
import { truncatedTimestamp } from './helpers/document-data.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function streamingReadTimeSuite(context: FirestoreBridgeTestContext) {
  // Unique root collection name avoids emulator cross-suite collisions.
  const COLLECTION_ID = 'Streaming & ReadTime';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);

      // Seed a small, deterministic dataset we can stream repeatedly.
      const col = FirestoreDb.collection(COLLECTION_ID);
      const batch = FirestoreDb.batch();
      for (let i = 1; i <= 8; i++) {
        batch.set(col.doc(`doc-${i}`), { i, kind: 'seed' });
      }
      await batch.commit();
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('QuerySnapshot.readTime exists and is monotonic (non-decreasing) across sequential reads', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const r1 = await col.get();
      const t1 = r1.readTime;
      expect(t1).toBeInstanceOf(Timestamp);

      // Small delay + write to ensure observable advancement in most environments.
      await new Promise((res) => setTimeout(res, 20));
      await col.doc('doc-advance-1').set({ bump: 1 });

      const r2 = await col.get();
      const t2 = r2.readTime;

      // Use millisecond truncation for portability across environments.
      const m1 = truncatedTimestamp(t1).toMillis();
      const m2 = truncatedTimestamp(t2).toMillis();
      expect(m2).toBeGreaterThanOrEqual(m1);

      // Do a few more cycles to assert non-decreasing property holds repeatedly.
      await new Promise((res) => setTimeout(res, 20));
      await col.doc('doc-advance-2').set({ bump: 2 });
      const r3 = await col.get();
      const m3 = truncatedTimestamp(r3.readTime).toMillis();
      expect(m3).toBeGreaterThanOrEqual(m2);

      await new Promise((res) => setTimeout(res, 20));
      await col.doc('doc-advance-3').set({ bump: 3 });
      const r4 = await col.get();
      const m4 = truncatedTimestamp(r4.readTime).toMillis();
      expect(m4).toBeGreaterThanOrEqual(m3);
    });

    it('stream() over a non-empty collection yields each document exactly once and then terminates', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);

      const seen = new Set<string>();
      const duplicates: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const s = col.stream();

        s.on('data', (snap: FirebaseFirestore.QueryDocumentSnapshot) => {
          const id = snap.id;
          // Access data using public API only (no non-null assertions).
          if (seen.has(id)) {
            duplicates.push(id);
          } else {
            seen.add(id);
          }
        });

        s.on('end', () => resolve());
        s.on('error', (err: unknown) => reject(err));
      });

      // We seeded 8 docs; streaming should return exactly those 8 once each.
      expect(duplicates).toHaveLength(0);
      expect(seen.size).toBeGreaterThanOrEqual(8); // Allow for advance-* docs not present at seed time
      // Ensure at least the seeded set is present.
      for (let i = 1; i <= 8; i++) {
        expect(seen.has(`doc-${i}`)).toBe(true);
      }
    });

    it('stream() over an empty query terminates cleanly with zero results', async () => {
      // Use a distinctly named sub-collection that we do not populate.
      const emptyCol = FirestoreDb.collection(`${COLLECTION_ID}__empty`);

      let count = 0;

      await new Promise<void>((resolve, reject) => {
        const s = emptyCol.stream();

        s.on('data', () => {
          count++;
        });
        s.on('end', () => resolve());
        s.on('error', (err: unknown) => reject(err));
      });

      expect(count).toBe(0);
    });

    it('QuerySnapshot.readTime reflects subsequent writes (non-decreasing even when no changes match the query)', async () => {
      const col = FirestoreDb.collection(COLLECTION_ID);
      const onlyDoc1 = col.where('i', '==', 1);

      const a = await onlyDoc1.get();
      const aMs = truncatedTimestamp(a.readTime).toMillis();

      // Perform an unrelated write (won’t affect the filtered result set)
      await new Promise((res) => setTimeout(res, 15));
      await col.doc('unrelated').set({ x: 1 });

      const b = await onlyDoc1.get();
      const bMs = truncatedTimestamp(b.readTime).toMillis();

      // Even though the query result content likely didn't change, readTime should not go backwards.
      expect(bMs).toBeGreaterThanOrEqual(aMs);
    });
  });
}
