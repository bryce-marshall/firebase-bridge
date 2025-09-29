/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Realtime Listeners — CollectionReference.onSnapshot
 *
 * Goal: Verify Admin SDK parity for collection listeners using only public APIs.
 *
 * Surfaces:
 *  - CollectionReference.onSnapshot(listener, error?)
 *  - Ordering by __name__ (implicit for CollectionReference)
 *
 * Invariants exercised:
 *  1) Initial emission contains all existing docs as `added`, ordered by __name__ asc
 *  2) Create emits `added` with correct newIndex
 *  3) Update emits a single `modified` with stable index (no rename)
 *  4) Delete emits `removed` with correct oldIndex
 *  5) Large bursts may coalesce; final ordering/size are correct
 *  6) Subcollection writes do not affect parent collection listener
 *  7) Cleanup: listeners are always unsubscribed
 */

import { DocumentData, Firestore, Timestamp } from 'firebase-admin/firestore';
import { collect } from './helpers/snapshot-collector.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function collectionOnSnapshotSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Realtime Listeners — CollectionReference.onSnapshot';

  describe(COLLECTION_ID, () => {
    let FirestoreDb: Firestore;

    beforeAll(async () => {
      FirestoreDb = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    const sanitize = (s: string) =>
      s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

    // Use a per-test subcollection under a fixed container doc to avoid cross-test interference
    const colRef = () => {
      const name = sanitize(
        expect.getState().currentTestName ?? 'unknown_test'
      );
      return FirestoreDb.collection(COLLECTION_ID)
        .doc('container')
        .collection(name);
    };

    it('initial emission: delivers all existing docs as added, ordered by __name__ ascending', async () => {
      const col = colRef();
      // Seed a couple documents BEFORE subscribing
      await col.doc('a').set({ n: 1 });
      await col.doc('m').set({ n: 2 });
      await col.doc('z').set({ n: 3 });

      const collector = collect(col);
      try {
        const first = await collector.first;
        // Query-target emission
        expect(first.querySnapshot).toBeDefined();
        expect(first.ids).toEqual(['a', 'm', 'z']); // implicit orderBy(__name__)

        // All changes should be 'added' with indices 0..N-1
        const changes = first.changes!;
        expect(changes.map((c) => c.type)).toEqual(['added', 'added', 'added']);
        expect(changes.map((c) => c.id)).toEqual(['a', 'm', 'z']);
        expect(changes.map((c) => c.newIndex)).toEqual([0, 1, 2]);
      } finally {
        collector.stop();
      }
    });

    it('create: new doc appears as added with correct newIndex based on __name__ order', async () => {
      const col = colRef();
      await col.doc('a').set({ v: 1 });
      await col.doc('m').set({ v: 2 });

      const collector = collect(col);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['a', 'm']);

        // Insert 'f' → should slot between 'a' and 'm' at index 1
        const e = await collector.waitForNext(() => col.doc('f').set({ v: 9 }));
        expect(e.ids).toEqual(['a', 'f', 'm']);

        const add = e.changes!.find((c) => c.type === 'added' && c.id === 'f')!;
        expect(add.newIndex).toBe(1);
      } finally {
        collector.stop();
      }
    });

    it('update: modifies in place with stable index (no rename)', async () => {
      const col = colRef();
      await col.doc('a').set({ n: 1 });
      await col.doc('m').set({ n: 2 });
      await col.doc('z').set({ n: 3 });

      const collector = collect(col);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['a', 'm', 'z']);

        // Update middle doc
        const e = await collector.waitForNext(() =>
          col.doc('m').update({ n: 22 })
        );

        // Still the same order; a single 'modified' change with same index
        expect(e.ids).toEqual(['a', 'm', 'z']);
        const mod = e.changes!.find(
          (c) => c.type === 'modified' && c.id === 'm'
        )!;
        expect(mod.oldIndex).toBe(1);
        expect(mod.newIndex).toBe(1);

        // Data visible on snapshot
        const snap = e.querySnapshot!;
        const mDoc = snap.docs.find((d) => d.id === 'm')!;
        const data = mDoc.data() as DocumentData;
        expect(data.n).toBe(22);
      } finally {
        collector.stop();
      }
    });

    it('delete: removed change with correct oldIndex; ordering remains valid', async () => {
      const col = colRef();
      await col.doc('a').set({ n: 1 });
      await col.doc('m').set({ n: 2 });
      await col.doc('z').set({ n: 3 });

      const collector = collect(col);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['a', 'm', 'z']);

        const e = await collector.waitForNext(() => col.doc('m').delete());

        // Remaining docs in order
        expect(e.ids).toEqual(['a', 'z']);
        const rem = e.changes!.find(
          (c) => c.type === 'removed' && c.id === 'm'
        )!;
        expect(rem.oldIndex).toBe(1);
        expect(rem.newIndex).toBe(-1); // Admin SDK convention for removed
      } finally {
        collector.stop();
      }
    });

    it('large burst: final size and ordering are correct even if emissions coalesce', async () => {
      const col = colRef();
      // Start listener first (empty collection)
      const collector = collect(col);
      try {
        await collector.first; // initial (empty)

        // Fire a bunch of inserts quickly (no awaits between them)
        const writes: Promise<unknown>[] = [];
        const ids = ['b', 'a', 'e', 'd', 'c', 'g', 'f'];
        for (const id of ids) {
          writes.push(col.doc(id).set({ id, t: Timestamp.now().toMillis() }));
        }
        await Promise.all(writes);

        // Wait until we see all documents present, in __name__ order
        await collector.waitUntil((ems) => {
          // console.log('ems', ems);
          const last = ems.at(-1)!;
          // console.log('last', last);
          return Array.isArray(last.ids) && last.ids.length === ids.length;
        }, 6000);

        const finalIds = collector.last().ids!;
        const expected = [...ids].sort(); // __name__ ascending
        expect(finalIds).toEqual(expected);
      } finally {
        collector.stop();
      }
    }, 6000);

    it('limit(n): boundary moves when new smaller ids are added (implicit orderBy __name__)', async () => {
      const col = colRef();
      await col.doc('m').set({ n: 1 });
      await col.doc('z').set({ n: 2 });

      const limited = col.limit(2); // will show ['m', 'z'] initially
      const collector = collect(limited);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['m', 'z']);

        // Insert 'a' (lexicographically smallest) → should push out 'z'
        const e = await collector.waitForNext(() => col.doc('a').set({ n: 0 }));
        expect(e.ids).toEqual(['a', 'm']); // top-2 by __name__

        // Insert 'b' → becomes ['a','b'], pushing out 'm'
        const e2 = await collector.waitForNext(() =>
          col.doc('b').set({ n: 0 })
        );
        expect(e2.ids).toEqual(['a', 'b']);
      } finally {
        collector.stop();
      }
    });

    it('writes to subcollections do not affect parent collection listener', async () => {
      const col = colRef();
      await col.doc('p1').set({ n: 1 });

      const collector = collect(col);
      try {
        const first = await collector.first;
        expect(first.ids).toEqual(['p1']);

        const before = collector.emissions.length;

        // Write in subcollection – should NOT trigger a parent collection emission
        await col.doc('p1').collection('kids').doc('k1').set({ sub: true });

        // Give the listener a moment; adjust window if your env is slow
        await new Promise((r) => setTimeout(r, 250));

        expect(collector.emissions.length).toBe(before); // no new emissions
      } finally {
        collector.stop();
      }
    });
  });
}
