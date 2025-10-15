import {
  DocumentData,
  Firestore,
  Timestamp,
  FieldPath,
} from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { normalizeDocData } from './helpers/document-data.js';
import { ExpectError } from './helpers/expect.error.js';
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
  });
}
