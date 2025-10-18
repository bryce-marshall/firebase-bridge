import {
  AggregateField,
  DocumentData,
  Firestore,
} from 'firebase-admin/firestore';
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

    describe('Transactions', () => {
      //
      // Aggregations inside transactions via Transaction.get(AggregateQuery)
      //
      it('transaction: tx.get(count()) with a filter returns expected value', async () => {
        const c = await FirestoreDb.runTransaction(async (tx) => {
          const agg = FirestoreDb.collection(COLLECTION_ID)
            .where('active', '==', true)
            .count();

          const snap = await tx.get(agg);
          return snap.data().count;
        });

        expect(c).toBe(2);
      });

      it('transaction: two aggregates via tx.get() in the same transaction', async () => {
        const result = await FirestoreDb.runTransaction(async (tx) => {
          const top2 = FirestoreDb.collection(COLLECTION_ID)
            .orderBy('points', 'desc')
            .limit(2)
            .aggregate({
              totalPoints: AggregateField.sum('points'),
              count: AggregateField.count(),
            });

          const activeAvg = FirestoreDb.collection(COLLECTION_ID)
            .where('active', '==', true)
            .aggregate({
              avgAge: AggregateField.average('details.age'),
              count: AggregateField.count(),
            });

          const [top2Snap, activeSnap] = await Promise.all([
            tx.get(top2),
            tx.get(activeAvg),
          ]);

          return { top2: top2Snap.data(), active: activeSnap.data() };
        });

        // Top 2 by points: u2 (30) + u3 (25) = 55
        expect(result.top2.count).toBe(2);
        expect(result.top2.totalPoints).toBe(55);

        // Active users: u1 (age 20), u2 (age 40)
        expect(result.active.count).toBe(2);
        expect(result.active.avgAge).toBe(30);
      });

      it('transaction: mix aggregate + query + doc reads via tx.get()', async () => {
        const out = await FirestoreDb.runTransaction(async (tx) => {
          const countAll = FirestoreDb.collection(COLLECTION_ID).count();
          const lowestPointsQ = FirestoreDb.collection(COLLECTION_ID)
            .orderBy('points', 'asc')
            .limit(1);
          const u2Ref = FirestoreDb.collection(COLLECTION_ID).doc('u2');

          const [countSnap, lowQSnap, u2Snap] = await Promise.all([
            tx.get(countAll), // AggregateQuerySnapshot
            tx.get(lowestPointsQ), // QuerySnapshot
            tx.get(u2Ref), // DocumentSnapshot
          ]);

          return {
            total: countSnap.data().count,
            lowestId: lowQSnap.docs[0]?.id,
            u2Points: u2Snap.exists
              ? (u2Snap.data() as DocumentData).points
              : undefined,
          };
        });

        expect(out.total).toBe(3);
        expect(out.lowestId).toBe('u1'); // points = 10
        expect(out.u2Points).toBe(30);
      });

      it('transaction: tx.get(aggregate) returns null average on empty set', async () => {
        const res = await FirestoreDb.runTransaction(async (tx) => {
          const agg = FirestoreDb.collection(COLLECTION_ID)
            .where('points', '>', 999)
            .aggregate({
              avgAge: AggregateField.average('details.age'),
              totalPoints: AggregateField.sum('points'),
              count: AggregateField.count(),
            });

          const snap = await tx.get(agg);
          return snap.data();
        });

        expect(res.count).toBe(0);
        expect(res.totalPoints).toBe(0);
        expect(res.avgAge).toBeNull();
      });
    });
  });
}
