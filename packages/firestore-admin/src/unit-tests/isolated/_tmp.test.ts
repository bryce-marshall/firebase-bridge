import { AggregateField, DocumentData } from 'firebase-admin/firestore';
import { FirestoreMock } from '../..';

describe('DataAccessor trigger (low-level in-memory)', () => {
  const env = new FirestoreMock();
  const ctrl = env.createDatabase();
  const FirestoreDb = ctrl.firestore();

  const COLLECTION_ID = 'Aggregations root collection';

  beforeAll(async () => {
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

//   it('transaction: two aggregates via tx.get() in the same transaction', async () => {
//     const result = await FirestoreDb.runTransaction(async (tx) => {
//       const top2 = FirestoreDb.collection(COLLECTION_ID)
//         .orderBy('points', 'desc')
//         .limit(2)
//         .aggregate({
//           totalPoints: AggregateField.sum('points'),
//           count: AggregateField.count(),
//         });

//       const activeAvg = FirestoreDb.collection(COLLECTION_ID)
//         .where('active', '==', true)
//         .aggregate({
//           avgAge: AggregateField.average('details.age'),
//           count: AggregateField.count(),
//         });

//       const [top2Snap, activeSnap] = await Promise.all([
//         tx.get(top2),
//         tx.get(activeAvg),
//       ]);

//       return { top2: top2Snap.data(), active: activeSnap.data() };
//     });

//     // Top 2 by points: u2 (30) + u3 (25) = 55
//     expect(result.top2.count).toBe(2);
//     expect(result.top2.totalPoints).toBe(55);

//     // Active users: u1 (age 20), u2 (age 40)
//     expect(result.active.count).toBe(2);
//     expect(result.active.avgAge).toBe(30);
//   });

//   it('transaction: mix aggregate + query + doc reads via tx.get()', async () => {
//     const out = await FirestoreDb.runTransaction(async (tx) => {
//       const countAll = FirestoreDb.collection(COLLECTION_ID).count();
//       const lowestPointsQ = FirestoreDb.collection(COLLECTION_ID)
//         .orderBy('points', 'asc')
//         .limit(1);
//       const u2Ref = FirestoreDb.collection(COLLECTION_ID).doc('u2');

//       const [countSnap, lowQSnap, u2Snap] = await Promise.all([
//         tx.get(countAll), // AggregateQuerySnapshot
//         tx.get(lowestPointsQ), // QuerySnapshot
//         tx.get(u2Ref), // DocumentSnapshot
//       ]);

//       return {
//         total: countSnap.data().count,
//         lowestId: lowQSnap.docs[0]?.id,
//         u2Points: u2Snap.exists
//           ? (u2Snap.data() as DocumentData).points
//           : undefined,
//       };
//     });

//     expect(out.total).toBe(3);
//     expect(out.lowestId).toBe('u1'); // points = 10
//     expect(out.u2Points).toBe(30);
//   });

//   it('transaction: tx.get(aggregate) returns null average on empty set', async () => {
//     const res = await FirestoreDb.runTransaction(async (tx) => {
//       const agg = FirestoreDb.collection(COLLECTION_ID)
//         .where('points', '>', 999)
//         .aggregate({
//           avgAge: AggregateField.average('details.age'),
//           totalPoints: AggregateField.sum('points'),
//           count: AggregateField.count(),
//         });

//       const snap = await tx.get(agg);
//       return snap.data();
//     });

//     expect(res.count).toBe(0);
//     expect(res.totalPoints).toBe(0);
//     expect(res.avgAge).toBeNull();
//   });
});
