import {
  AggregateField,
  DocumentData,
  FieldPath,
  FieldValue,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { normalizeDocData } from './helpers/document-data.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function backtickedFieldPathsSuite(context: FirestoreBridgeTestContext) {
  const COLLECTION_ID = 'Backticked Field Paths';

  describe(COLLECTION_ID, () => {
    let Firestore!: Firestore;

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    function col() {
      return Firestore.collection(COLLECTION_ID);
    }

    const ODD = {
      hyphen: '-ObaMyiLsFvHXTTss63B',
      leadingDigit: '0abc',
      spaced: 'with space',
    };

    // ---------------------------------------------------------------------
    // Object writes (SDK builds mask) — unchanged and verified working
    // ---------------------------------------------------------------------
    describe('Object writes (SDK builds mask)', () => {
      it('set(..., {merge:true}) accepts nested maps with odd keys (mask built by SDK)', async () => {
        const doc = col().doc('auto-mask-nested-map');
        await doc.set(
          { _idxsup: { [ODD.hyphen]: { created: true } } },
          { merge: true }
        );

        const snap = await doc.get();
        expect(normalizeDocData(snap.data() as DocumentData)).toEqual({
          _idxsup: { [ODD.hyphen]: { created: true } },
        });
      });
    });

    // ---------------------------------------------------------------------
    // update() with FieldPath vs string — unchanged and verified working
    // ---------------------------------------------------------------------
    describe('update() with FieldPath vs string', () => {
      it('FieldPath succeeds for hyphen / leading digit / space segments', async () => {
        const doc = col().doc('update-fieldpath-odd');
        await doc.set({});

        await doc.update(new FieldPath('_idxsup', ODD.hyphen, 'a'), 1);
        await doc.update(new FieldPath('_idxsup', ODD.leadingDigit, 'b'), 2);
        await doc.update(new FieldPath('_idxsup', ODD.spaced, 'c'), 3);

        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({
          _idxsup: {
            [ODD.hyphen]: { a: 1 },
            [ODD.leadingDigit]: { b: 2 },
            [ODD.spaced]: { c: 3 },
          },
        });
      });

      it('UNQUOTED string path with odd segment is accepted by the Node SDK parser', async () => {
        const doc = col().doc('update-unquoted-string');
        await doc.set({});
        await doc.update(`_idxsup.${ODD.spaced}.v`, 1);
        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({
          _idxsup: {
            [ODD.spaced]: { v: 1 },
          },
        });
      });

      it('BACKTICK-QUOTED string path is treated literally (backticks become part of field names)', async () => {
        const doc = col().doc('update-quoted-string');
        await doc.set({});
        const quoted = `\`_idxsup\`.\`${ODD.spaced}\`.\`v\``;
        await doc.update(quoted, 1);
        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({
          ['`_idxsup`']: {
            [`\`${ODD.spaced}\``]: { '`v`': 1 },
          },
        });
      });
    });

    // ---------------------------------------------------------------------
    // set(..., { mergeFields }) — reworked: unquoted strings succeed; backticks are literal
    // ---------------------------------------------------------------------
    describe('set(..., { mergeFields })', () => {
      it('mergeFields with FieldPath targets only the specified odd path', async () => {
        const doc = col().doc('mergefields-fieldpath');
        await doc.set({ _idxsup: { [ODD.hyphen]: { created: 0, other: 99 } } });

        await doc.set(
          { _idxsup: { [ODD.hyphen]: { created: 1, other: 42 } } },
          { mergeFields: [new FieldPath('_idxsup', ODD.hyphen, 'created')] }
        );

        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({
          _idxsup: { [ODD.hyphen]: { created: 1, other: 99 } },
        });
      });

      it('mergeFields with UNQUOTED odd-string path is accepted by the Node SDK', async () => {
        const doc = col().doc('mergefields-unquoted-ok');
        await doc.set({ _idxsup: {} });

        // Unquoted string path — SDK splits literally and applies merge to that path.
        await doc.set(
          { _idxsup: { [ODD.leadingDigit]: { x: 1 } } },
          { mergeFields: [`_idxsup.${ODD.leadingDigit}.x`] }
        );

        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({ _idxsup: { [ODD.leadingDigit]: { x: 1 } } });
      });

      it('mergeFields with BACKTICK-QUOTED string path is treated literally', async () => {
        const doc = col().doc('mergefields-quoted-literal');
        await doc.set({});

        const quoted = `\`_idxsup\`.\`${ODD.leadingDigit}\`.\`y\``;

        await doc.set(
          {
            ['`_idxsup`']: {
              [`\`${ODD.leadingDigit}\``]: { '`y`': 123 },
            },
          },
          { mergeFields: [quoted] }
        );

        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({
          ['`_idxsup`']: {
            [`\`${ODD.leadingDigit}\``]: { '`y`': 123 },
          },
        });
      });
    });

    // ---------------------------------------------------------------------
    // WriteBatch / BulkWriter — strings reject; FieldPath succeeds
    // ---------------------------------------------------------------------
    describe('WriteBatch / BulkWriter', () => {
      it('WriteBatch: FieldPath and UNQUOTED string paths work (SDK splits literally)', async () => {
        const ref = col().doc('wb-odd-paths');
        await ref.set({});

        const batch = Firestore.batch();
        // FieldPath path (hyphen) — always OK
        batch.update(ref, new FieldPath('_idxsup', ODD.hyphen, 'c'), true);
        // Unquoted string paths (SDK splits literally) — observed OK in emulator
        batch.update(ref, `_idxsup.${ODD.hyphen}.d`, 1);
        batch.update(ref, `_idxsup.${ODD.spaced}.e`, 2);

        await batch.commit();

        const d = normalizeDocData((await ref.get()).data() as DocumentData);
        expect(d).toEqual({
          _idxsup: {
            [ODD.hyphen]: { c: true, d: 1 },
            [ODD.spaced]: { e: 2 },
          },
        });
      });

      it('BulkWriter: FieldPath updates succeed on odd segments', async () => {
        const target = col().doc('bw-odd-paths');
        await target.set({});

        const writer = Firestore.bulkWriter();
        let success = 0;

        writer.onWriteResult((_ref, res) => {
          expect(res.writeTime).toBeInstanceOf(Timestamp);
          success++;
        });

        writer.update(target, new FieldPath('_idxsup', ODD.spaced, 'k'), 'ok');
        writer.update(
          target,
          new FieldPath('_idxsup', ODD.leadingDigit, 'k'),
          'ok'
        );

        await writer.close();
        expect(success).toBe(2);

        const d = normalizeDocData((await target.get()).data() as DocumentData);
        expect(d).toEqual({
          _idxsup: {
            [ODD.spaced]: { k: 'ok' },
            [ODD.leadingDigit]: { k: 'ok' },
          },
        });
      });
    });

    // ---------------------------------------------------------------------
    // Queries (filters/order/aggregate) with odd/backticked paths
    // ---------------------------------------------------------------------
    describe('Queries: filters / aggregates / vector with odd/backticked paths', () => {
      const subCol = () => col().doc('subdoc01').collection('subcol01');
      // Seed a small fixture
      beforeAll(async () => {
        const base = subCol();

        await Promise.all([
          base.doc('q1').set({
            _idxsup: {
              [ODD.spaced]: {
                v: 1,
                n: 2,
                tag: 'A',
                vec: FieldValue.vector([0.1, 0.2, 0.3]),
              },
              [ODD.hyphen]: { v: 3, n: 5, tag: 'A' },
              [ODD.leadingDigit]: { v: 4, n: 7, tag: 'B' },
            },
          }),
          base.doc('q2').set({
            _idxsup: {
              [ODD.spaced]: {
                v: 1,
                n: 8,
                tag: 'A',
                vec: FieldValue.vector([0.0, 0.2, 0.4]),
              },
              [ODD.hyphen]: { v: 9, n: 1, tag: 'B' },
            },
          }),
          base.doc('q3').set({
            ['`_idxsup`']: { ['`with space`']: { ['`v`']: 42 } },
          }),
        ]);
      });

      it('filter with FieldPath over odd segment (space) matches as expected', async () => {
        const qp = await subCol()
          .where(new FieldPath('_idxsup', ODD.spaced, 'v'), '==', 1)
          .get();
        const ids = qp.docs.map((d) => d.id).sort();
        expect(ids).toEqual(['q1', 'q2']);
      });

      it('filter with BACKTICK-quoted string is literal and only matches literal backtick keys', async () => {
        const quoted = `\`_idxsup\`.\`${ODD.spaced}\`.\`v\``;
        const qp = await subCol().where(quoted, '==', 42).get();
        const ids = qp.docs.map((d) => d.id);
        expect(ids).toEqual(['q3']); // only the literal backticked doc matches
      });

      it('orderBy on an odd path via FieldPath works', async () => {
        const qs = await subCol()
          .orderBy(new FieldPath('_idxsup', ODD.hyphen, 'n'))
          .get();
        // q2 has n=1 under hyphen; q1 has n=5
        const ids = qs.docs.map((d) => d.id);
        expect(ids[0]).toBe('q2');
      });

      it('aggregate: sum on odd path via FieldPath works', async () => {
        const agg = await subCol()
          .where(new FieldPath('_idxsup', ODD.spaced, 'tag'), '==', 'A')
          .aggregate({
            totalN: AggregateField.sum(
              new FieldPath('_idxsup', ODD.spaced, 'n')
            ),
            countA: AggregateField.count(),
          })
          .get();
        expect(agg.data().totalN).toBe(2 + 8);
        expect(agg.data().countA).toBe(2);
      });

      // This is a current Firestore bug: https://github.com/firebase/firebase-tools/issues/8077
      // it('vector search: findNearest using a quoted string path on odd segment', async () => {
      //   const vectorField = `\`_idxsup\`.\`${ODD.spaced}\`.\`vec\``; // backtick-quoted string path

      //   const res = await subCol()
      //     .findNearest({
      //       vectorField, // use string path, not FieldPath
      //       queryVector: [0.09, 0.21, 0.31],
      //       distanceMeasure: 'EUCLIDEAN',
      //       limit: 1,
      //     })
      //     .get();

      //   const ids = res.docs.map((d) => d.id);
      //   expect(ids).toEqual(['q1']);
      // });
    });

    // ---------------------------------------------------------------------
    // Writes with transforms (sentinels) on odd/backticked paths
    // ---------------------------------------------------------------------
    describe('Transforms with odd/backticked field paths', () => {
      it('set(..., {merge:true}) with object containing FieldValue.increment at odd path stores correctly', async () => {
        const doc = col().doc('tf-inc-object');
        await doc.set({}); // ensure exists

        // Increment at _idxsup["0abc"].n and _idxsup["with space"].n via object nesting
        await doc.set(
          {
            _idxsup: {
              [ODD.leadingDigit]: { n: FieldValue.increment(2) },
              [ODD.spaced]: { n: FieldValue.increment(3) },
            },
          },
          { merge: true }
        );

        const d1 = (await doc.get()).data();
        expect(d1).toEqual({
          _idxsup: {
            [ODD.leadingDigit]: { n: 2 },
            [ODD.spaced]: { n: 3 },
          },
        });

        console.log('data d1:', d1);

        // Do another increment using FieldPath to prove additive behavior
        await doc.update(
          new FieldPath('_idxsup', ODD.leadingDigit, 'n'),
          FieldValue.increment(5)
        );
        const d2 = (await doc.get()).data();
        console.log('data d2:', d2);
        expect(d2).toEqual({
          _idxsup: {
            [ODD.leadingDigit]: { n: 7 },
            [ODD.spaced]: { n: 3 },
          },
        });
      });

      it('update(FieldPath, FieldValue.serverTimestamp) on odd path sets a Timestamp', async () => {
        const doc = col().doc('tf-st-object');
        await doc.set({});
        await doc.update(
          new FieldPath('_idxsup', ODD.hyphen, 'ts'),
          FieldValue.serverTimestamp()
        );

        const got = (await doc.get()).get(
          new FieldPath('_idxsup', ODD.hyphen, 'ts')
        );
        // Emulators return Timestamp; mock should mirror
        expect(got).toBeInstanceOf(Timestamp);
      });

      it('arrayUnion on odd path via FieldPath works', async () => {
        const doc = col().doc('tf-au-object');
        await doc.set({});

        await doc.update(
          new FieldPath('_idxsup', ODD.spaced, 'arr'),
          FieldValue.arrayUnion('a', 'b', 'a')
        );
        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({ _idxsup: { [ODD.spaced]: { arr: ['a', 'b'] } } });

        await doc.update(
          new FieldPath('_idxsup', ODD.spaced, 'arr'),
          FieldValue.arrayUnion('b', 'c')
        );
        const d2 = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d2).toEqual({
          _idxsup: { [ODD.spaced]: { arr: ['a', 'b', 'c'] } },
        });
      });

      it('BACKTICK-quoted string in update(...) is literal for transforms, creating backtick keys', async () => {
        const doc = col().doc('tf-quoted-literal');
        await doc.set({});

        const quoted = `\`_idxsup\`.\`${ODD.leadingDigit}\`.\`m\``;
        await doc.update(quoted, FieldValue.increment(10));

        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({
          ['`_idxsup`']: {
            [`\`${ODD.leadingDigit}\``]: { '`m`': 10 },
          },
        });
      });

      it('numeric key via increment in object (e.g., {[9]: FieldValue.increment(1)}) stores as "9" (no backticks)', async () => {
        const doc = col().doc('tf-numeric-key');
        await doc.set({});
        await doc.set({ [9]: FieldValue.increment(1) }, { merge: true });

        const d = normalizeDocData((await doc.get()).data() as DocumentData);
        expect(d).toEqual({ ['9']: 1 });
      });
    });
  });
}
