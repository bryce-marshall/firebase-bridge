import { AggregateField, Firestore } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from './test-context.js';

export function aggregationsSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Aggregations root collection';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);

      const base = FirestoreDb.collection(COLLECTION_ID);
      // Seed some documents
      await base
        .doc('u1')
        .set({ active: true, points: 10, details: { age: 20 } });
      await base
        .doc('u2')
        .set({ active: true, points: 30, details: { age: 40 } });
      await base
        .doc('u3')
        .set({ active: false, points: 25, details: { age: 30 } });
    });

    afterAll(async () => {
      await context.tearDown();
    });

    describe('count()', () => {
      it('returns 0 for empty collection', async () => {
        const emptyCol = FirestoreDb.collection(`${COLLECTION_ID}_empty`);
        const snap = await emptyCol.count().get();
        expect(snap.data().count).toBe(0);
      });

      it('counts all documents', async () => {
        const snap = await FirestoreDb.collection(COLLECTION_ID).count().get();
        expect(snap.data().count).toBe(3);
      });

      it('counts with filters', async () => {
        const snap = await FirestoreDb.collection(COLLECTION_ID)
          .where('active', '==', true)
          .count()
          .get();
        expect(snap.data().count).toBe(2);
      });

      it('counts with ordering and limits', async () => {
        const snap = await FirestoreDb.collection(COLLECTION_ID)
          .orderBy('points', 'desc')
          .limit(2)
          .count()
          .get();
        expect(snap.data().count).toBe(2);
      });
    });

    describe('aggregate()', () => {
      it('computes count, sum, and average with filter', async () => {
        const q = FirestoreDb.collection(COLLECTION_ID).where(
          'active',
          '==',
          true
        );

        const agg = q.aggregate({
          avgAge: AggregateField.average('details.age'),
          totalPoints: AggregateField.sum('points'),
          count: AggregateField.count(),
        });

        const snap = await agg.get();
        const { avgAge, totalPoints, count } = snap.data();

        expect(count).toBe(2);
        expect(totalPoints).toBe(40); // 10 + 30
        expect(avgAge).toBe(30); // (20 + 40) / 2
      });

      it('returns null for average on empty set', async () => {
        const q = FirestoreDb.collection(COLLECTION_ID).where(
          'points',
          '>',
          999
        );
        const agg = q.aggregate({
          avgAge: AggregateField.average('details.age'),
          totalPoints: AggregateField.sum('points'),
          count: AggregateField.count(),
        });
        const snap = await agg.get();
        const { avgAge, totalPoints, count } = snap.data();

        expect(count).toBe(0);
        expect(totalPoints).toBe(0);
        expect(avgAge).toBeNull();
      });

      it('works with orderBy + limit', async () => {
        const q = FirestoreDb.collection(COLLECTION_ID)
          .orderBy('points', 'asc')
          .limit(2);

        const agg = q.aggregate({
          totalPoints: AggregateField.sum('points'),
          count: AggregateField.count(),
        });
        const snap = await agg.get();
        const { totalPoints, count } = snap.data();

        expect(count).toBe(2);
        expect(totalPoints).toBe(35); // 10 + 25
      });

      it('can alias count with FieldPath', async () => {
        const q = FirestoreDb.collection(COLLECTION_ID);
        const agg = q.aggregate({
          c: AggregateField.count(),
        });
        const snap = await agg.get();
        expect(snap.data().c).toBe(3);
      });
    });
  });
}
