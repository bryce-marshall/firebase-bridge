// firestore-bridge-test-suites/src/data-model-and-serialization.suite.ts
import {
  DocumentData,
  FieldValue,
  Firestore,
  GeoPoint,
  Timestamp,
} from 'firebase-admin/firestore';
import {
  isDocDataEqual,
  normalizeDocData,
  truncatedTimestamp,
} from './helpers/document-data.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function dataModelSerializationSuite(
  context: FirestoreBridgeTestContext
) {
  // Unique root collection name prevents collisions in emulator for post-run inspection
  const COLLECTION_ID = 'Data Model & Serialization (Black-box)';

  describe(COLLECTION_ID, () => {
    let db!: Firestore;

    beforeAll(async () => {
      db = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    //
    // ---------- Helpers ----------
    //

    function expectDataEqual(actual: unknown, expected: unknown): void {
      expect(isDocDataEqual(actual, expected)).toBe(true);
      // expect(true).toBe(true);
    }

    //
    // ---------- Primitives ----------
    //
    it('primitives round-trip via document get()', async () => {
      const col = db.collection(COLLECTION_ID).doc('primitives');
      const target = db.collection(COLLECTION_ID).doc('ref-target');
      await target.set({ ok: true });

      const unicodeEdge =
        'A\u0000B — emoji: 👨‍👩‍👧‍👦 🧪; accents: café; surrogate: 𝄞; RTL: שלום';

      const payload: DocumentData = {
        nullV: null,
        boolT: true,
        boolF: false,
        intV: Number.MAX_SAFE_INTEGER, // keep JS number; BigInt not stored in Firestore
        negInt: -1234567890,
        dbl: 12345.6789,
        plusInf: Infinity,
        minusInf: -Infinity,
        nanV: NaN,
        str: unicodeEdge,
        bytes: new Uint8Array([0, 1, 2, 255]),
        gp: new GeoPoint(-36.8485, 174.7633),
        ts: new Timestamp(1600000000, 12346),
        ref: target,
      };

      const expected = normalizeDocData(payload);
      await col.set(payload);
      const snap = await col.get();
      const data = snap.data() as DocumentData;

      // Type-preserving deep equality
      expectDataEqual(data, expected);
    });

    //   //
    //   // ---------- Containers ----------
    //   //
    it('nested maps and heterogeneous arrays (incl. nested & large) round-trip', async () => {
      const col = db.collection(COLLECTION_ID).doc('containers');
      const target = db.collection(COLLECTION_ID).doc('containers-ref');
      await target.set({ role: 'target' });

      const bigArr = Array.from({ length: 1000 }, (_, i) => i);

      const payload: DocumentData = {
        tag: 'containers',
        map: {
          a: 1,
          b: 'two',
          c: {
            inner: true,
            deeper: { nope: null, when: new Timestamp(1700000000, 999) },
          },
        },
        // No arrays inside this array's elements
        arr: [
          1,
          'x',
          null,
          new GeoPoint(0, 0),
          new Timestamp(2000000000, 1),
          new Uint8Array([9, 8, 7]),
          target,
          // use an object that contains an array, rather than an array element that is an array
          { nestedArr: [false, 'nested', new GeoPoint(1, 2)] },
          { o: { oo: 'k' } },
        ],
        bigArr,
      };

      const expected = normalizeDocData(payload);

      await col.set(payload);
      const snap = await col.get();
      const data = snap.data() as DocumentData;

      expect(isDocDataEqual(data, expected)).toBe(true);
    });

    it('rejects nested arrays (array in array)', async () => {
      const ref = db.collection(COLLECTION_ID).doc('bad-arrays');
      await expect(ref.set({ a: [1, [2, 3]] })).rejects.toThrow(
        /array value in an array value/i
      );
    });

    //
    // ---------- Indirect serialization via queries ----------
    //
    it('query get() round-trips (EQUAL filter)', async () => {
      const col = db
        .collection(COLLECTION_ID)
        .doc('query-root')
        .collection('items');
      const target = db.collection(COLLECTION_ID).doc('query-ref-target');
      await target.set({ ok: true });

      const mk = 'roundtrip';
      const docs: DocumentData[] = [
        { tag: mk, index: 1, v: 'a', ref: target, when: Timestamp.now() },
        { tag: mk, index: 2, v: 'b', gp: new GeoPoint(1, 2) },
        { tag: 'other', index: 3, v: 'c' },
      ];

      const writes = docs.map((d, i) => col.doc(`d${i + 1}`).set(d));
      await Promise.all(writes);

      const qs = await col.where('tag', '==', mk).orderBy('index').get();
      const got = qs.docs.map((d) => d.data() as DocumentData);

      expect(got.length).toBe(2);
      expectDataEqual(got[0], docs[0]);
      expectDataEqual(got[1], docs[1]);
    });

    //
    // ---------- withConverter() round-trips ----------
    //
    it('withConverter() round-trips custom class mapping', async () => {
      class Person {
        constructor(
          public name: string,
          public created: Timestamp,
          public home?: GeoPoint
        ) {}
      }

      const converter = {
        toFirestore(p: Person): DocumentData {
          return { name: p.name, created: p.created, home: p.home ?? null };
        },
        fromFirestore(snap: FirebaseFirestore.QueryDocumentSnapshot): Person {
          const d = snap.data() as DocumentData;
          return new Person(d.name, d.created, d.home ?? undefined);
        },
      };

      const col = db.collection(COLLECTION_ID).withConverter(converter);
      const ref = col.doc('person-1');

      const original = new Person(
        'Ada Lovelace',
        new Timestamp(1234, 567),
        new GeoPoint(51.5, -0.12)
      );
      await ref.set(original);

      // Read via converter
      const snapConv = await ref.get();
      const person = snapConv.data() as Person;
      expect(person).toBeInstanceOf(Person);
      expect(person.name).toBe('Ada Lovelace');
      expect(person.created.isEqual(truncatedTimestamp(original.created))).toBe(
        true
      );
      expect(person.home?.latitude).toBeCloseTo(51.5, 12);

      // Read raw (no converter) and compare the stored serialization
      const rawSnap = await db.collection(COLLECTION_ID).doc('person-1').get();
      const raw = rawSnap.data() as DocumentData;
      const expected = normalizeDocData(converter.toFirestore(original));
      expectDataEqual(raw, expected);
    });

    //
    // ---------- Sentinels via FieldValue ----------
    //
    describe('FieldValue sentinels', () => {
      it('serverTimestamp() sets a Timestamp value', async () => {
        const ref = db.collection(COLLECTION_ID).doc('svrts');
        await ref.set({ a: FieldValue.serverTimestamp() });

        const snap = await ref.get();
        const d = snap.data() as DocumentData;
        expect(d.a).toBeInstanceOf(Timestamp);

        // sanity check: within a reasonable range of "now"
        const now = Timestamp.now();
        const a = d.a as Timestamp;
        const deltaSec = Math.abs(a.seconds - now.seconds);
        expect(deltaSec).toBeLessThan(60);
      });

      it('increment() on existing and missing fields', async () => {
        const ref = db.collection(COLLECTION_ID).doc('inc');
        await ref.set({ c: 10 });
        await ref.update({
          c: FieldValue.increment(5),
          missing: FieldValue.increment(3), // should behave as 0 + 3
        });

        const d = (await ref.get()).data() as DocumentData;
        expect(d.c).toBe(15);
        expect(d.missing).toBe(3);
      });

      it('arrayUnion() / arrayRemove() on flat and nested arrays', async () => {
        const ref = db.collection(COLLECTION_ID).doc('arrOps');
        await ref.set({
          arr: [1, 2, 3],
          nested: { arr: ['x'] },
        });

        await ref.update({
          arr: FieldValue.arrayUnion(3, 4, 5), // 3 already exists; 4 & 5 appended
          'nested.arr': FieldValue.arrayUnion('y', 'z'),
        });

        await ref.update({
          arr: FieldValue.arrayRemove(2, 999), // 2 removed; 999 no-op
          'nested.arr': FieldValue.arrayRemove('x'),
        });

        const d = (await ref.get()).data() as DocumentData;
        expect(d.arr).toEqual([1, 3, 4, 5]);
        expect(d.nested.arr).toEqual(['y', 'z']);
      });

      it('delete() removes fields (incl. nested via merge semantics)', async () => {
        const ref = db.collection(COLLECTION_ID).doc('delOps');

        await ref.set({
          keep: 1,
          rm: 2,
          a: { b: { x: 1, y: 2 } },
        });

        // update delete existing field
        await ref.update({ rm: FieldValue.delete() });

        // set with merge + dot-notation deletes nested 'y' and adds 'z'
        await ref.set(
          { a: { b: { y: FieldValue.delete(), z: 3 } } },
          { merge: true }
        );

        const d = (await ref.get()).data() as DocumentData;
        expect('rm' in d).toBe(false);
        expect(d.keep).toBe(1);
        expect(d.a.b.x).toBe(1);
        expect('y' in d.a.b).toBe(false);
        expect(d.a.b.z).toBe(3);
      });

      it('serverTimestamp(), increment(), array ops work within merged nested maps', async () => {
        const ref = db.collection(COLLECTION_ID).doc('nestedMerge');
        await ref.set({ profile: { visits: 0, tags: ['a'] } });

        await ref.set(
          {
            profile: {
              lastSeen: FieldValue.serverTimestamp(),
              visits: FieldValue.increment(2),
              tags: FieldValue.arrayUnion('b', 'c', 'a'),
            },
          } as unknown as DocumentData,
          { merge: true }
        );

        const d = (await ref.get()).data() as DocumentData;
        expect(d.profile.visits).toBe(2);
        expect(d.profile.tags).toEqual(['a', 'b', 'c']);
        expect(d.profile.lastSeen).toBeInstanceOf(Timestamp);
      });
    });

    //
    // ---------- Query reads of sentinel-written docs ----------
    //
    it('query get() returns data with resolved sentinel results', async () => {
      const col = db
        .collection(COLLECTION_ID)
        .doc('q-sentinels')
        .collection('items');

      const ref1 = col.doc('a');
      const ref2 = col.doc('b');

      await ref1.set({
        tag: 's',
        n: FieldValue.increment(10),
        when: FieldValue.serverTimestamp(),
      });
      await ref2.set({ tag: 's', n: 5 });

      // Update to exercise increment & array ops across docs
      await ref1.update({
        n: FieldValue.increment(1),
        arr: FieldValue.arrayUnion('x'),
      });
      await ref2.update({
        n: FieldValue.increment(2),
        arr: FieldValue.arrayUnion('x', 'y'),
      });

      const qs = await col.where('tag', '==', 's').orderBy('n').get();
      const items = qs.docs.map((d) => d.data() as DocumentData);

      // Ensure both docs present and values materialized
      expect(items.length).toBe(2);
      expect(items[0].n).toBe(7); // ref2: 5 + 2
      expect(items[1].n).toBe(11); // ref1: 10 + 1
      expect(items[0].arr).toEqual(['x', 'y']);
      expect(items[1].arr).toEqual(['x']);
      expect(items[1].when).toBeInstanceOf(Timestamp);
    });

    //
    // ---------- Unicode edge cases in strings ----------
    //
    it('strings with edge Unicode round-trip identically', async () => {
      const ref = db.collection(COLLECTION_ID).doc('unicode');
      const tricky = [
        'plain',
        'emoji 👩🏽‍🚀👨‍👩‍👧‍👦',
        'accents café naïve coöperate',
        'RTL שלום עולם',
        'ZWJ sequence: 👨‍👩‍👧‍👦',
        'surrogate 𝄞 (U+1D11E)',
        'null-byte \u0000 inside',
        'combining: ñ a̐ é ö å ̵', // combining marks
      ];
      await ref.set({ tricky });

      const d = (await ref.get()).data() as DocumentData;
      expect(d.tricky).toEqual(tricky);
    });
  });
}
