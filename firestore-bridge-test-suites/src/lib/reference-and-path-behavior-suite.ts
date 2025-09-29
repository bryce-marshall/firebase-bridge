import {
  Firestore as AdminFirestore,
  DocumentData,
  FieldPath,
} from 'firebase-admin/firestore';
import { ExpectError } from './helpers/expect.error.js';
import { FirestoreBridgeTestContext } from './test-context.js';

export function referenceAndPathBehaviorSuite(
  context: FirestoreBridgeTestContext
) {
  const COLLECTION_ID = 'Reference & Path Behavior';

  describe(COLLECTION_ID, () => {
    let Firestore: AdminFirestore;

    beforeAll(async () => {
      Firestore = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    describe('doc()/collection() edge IDs (Unicode, numeric-looking IDs)', () => {
      it('supports Unicode IDs and treats NFC/NFD variants as distinct', async () => {
        const base = Firestore.collection(COLLECTION_ID)
          .doc('unicode')
          .collection('ids');

        // café in NFC vs NFD
        const nfc = 'caf\u00E9';
        const nfd = 'cafe\u0301';

        const rNfc = base.doc(nfc);
        const rNfd = base.doc(nfd);

        await rNfc.set({ which: 'nfc' });
        await rNfd.set({ which: 'nfd' });

        const sNfc = await rNfc.get();
        const sNfd = await rNfd.get();

        const dNfc = sNfc.data() as DocumentData;
        const dNfd = sNfd.data() as DocumentData;

        expect(sNfc.exists).toBe(true);
        expect(sNfd.exists).toBe(true);
        expect(dNfc.which).toBe('nfc');
        expect(dNfd.which).toBe('nfd');

        // Exact ID & path round-trip
        expect(rNfc.id).toBe(nfc);
        expect(rNfd.id).toBe(nfd);
        expect(rNfc.path.endsWith(`/${nfc}`)).toBe(true);
        expect(rNfd.path.endsWith(`/${nfd}`)).toBe(true);
      });

      it('allows emoji and RTL IDs (Hebrew/Arabic); round-trips via __name__ equality', async () => {
        const base = Firestore.collection(COLLECTION_ID)
          .doc('i18n')
          .collection('ids');

        const ids = ['😀', '👩‍💻', 'שלום', 'مرحبا'];
        for (const id of ids) {
          await base.doc(id).set({ id });
        }

        for (const id of ids) {
          const ref = base.doc(id);
          const qs = await base.where(FieldPath.documentId(), '==', ref).get();
          expect(qs.size).toBe(1);
          expect(qs.docs[0].id).toBe(id);

          const d = qs.docs[0].data() as DocumentData;
          expect(d.id).toBe(id);

          // path/id formatting checks
          expect(ref.id).toBe(id);
          expect(ref.path.endsWith(`/${id}`)).toBe(true);
          expect(ref.parent.isEqual(base)).toBe(true);
        }
      });

      it('treats numeric-looking IDs purely as strings (distinct IDs are preserved)', async () => {
        const base = Firestore.collection(COLLECTION_ID)
          .doc('numeric-like')
          .collection('ids');

        const ids = ['1', '01', '001', '10', '٢', '١٢٣']; // includes Arabic-Indic digits
        let counter = 0;
        for (const id of ids) {
          await base.doc(id).set({ idx: ++counter });
        }

        // Fetch each by __name__ equality to ensure exact match
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          const ref = base.doc(id);
          const qs = await base.where(FieldPath.documentId(), '==', ref).get();

          expect(qs.size).toBe(1);
          expect(qs.docs[0].id).toBe(id);

          const d = qs.docs[0].data() as DocumentData;
          expect(d.idx).toBe(i + 1);
        }
      });

      it('auto-ID from doc() with no args yields a non-empty 20-char string id', async () => {
        const base = Firestore.collection(COLLECTION_ID)
          .doc('auto')
          .collection('ids');
        const ref = base.doc(); // auto-id
        await ref.set({ ok: true });

        expect(ref.id).toMatch(/^[A-Za-z0-9]{20}$/);
        const snap = await ref.get();
        const d = snap.data() as DocumentData;
        expect(d.ok).toBe(true);
      });
    });

    describe('Equality checks, path formatting, and absolute vs relative creation', () => {
      it('DocumentReference.isEqual() behaves correctly for same/different targets', async () => {
        const col = Firestore.collection(COLLECTION_ID)
          .doc('equality')
          .collection('docs');

        const a1 = col.doc('a');
        const a2 = col.doc('a');
        const b = col.doc('b');

        expect(a1.isEqual(a2)).toBe(true);
        expect(a1.isEqual(b)).toBe(false);

        // Also check CollectionReference equality
        const sameCol = Firestore.collection(`${COLLECTION_ID}/equality/docs`);
        expect(col.isEqual(sameCol)).toBe(true);
      });

      it('relative chaining into subcollections equals absolute Firestore.doc(path)', async () => {
        const root = Firestore.collection(COLLECTION_ID)
          .doc('parents')
          .collection('kids');

        // kids/x/y/z via chaining
        const yCol = root.doc('x').collection('y');
        const viaChain = yCol.doc('z');

        // Same doc via absolute path
        const viaAbsolute = Firestore.doc(
          `${COLLECTION_ID}/parents/kids/x/y/z`
        );

        expect(viaChain.id).toBe('z');
        expect(viaChain.parent.id).toBe('y');
        expect(viaChain.isEqual(viaAbsolute)).toBe(true);

        await viaChain.set({ ok: 'chain' });
        const sAbs = await viaAbsolute.get();
        const dAbs = sAbs.data() as DocumentData;
        expect(dAbs.ok).toBe('chain');

        // Path string output
        expect(viaChain.path).toBe(`${COLLECTION_ID}/parents/kids/x/y/z`);
        expect(viaChain.parent.path).toBe(`${COLLECTION_ID}/parents/kids/x/y`);
      });

      it('rejects slash-delimited IDs passed to CollectionReference.doc()', () => {
        const root = Firestore.collection(COLLECTION_ID)
          .doc('parents')
          .collection('kids');

        // Passing 'x/y' as an ID is invalid: doc() expects a single segment.
        ExpectError.inline(() => root.doc('x/y'), {
          match:
            /must point to a document|even number of components|documentPath/i,
        });
      });

      it('absolute paths via Firestore.doc()/Firestore.collection() match relative construction', async () => {
        const absCol = Firestore.collection(`${COLLECTION_ID}/abs/branch`);
        const relCol = Firestore.collection(COLLECTION_ID)
          .doc('abs')
          .collection('branch');
        expect(absCol.isEqual(relCol)).toBe(true);

        const absDoc = Firestore.doc(`${COLLECTION_ID}/abs/branch/leaf`);
        const relDoc = relCol.doc('leaf');
        expect(absDoc.isEqual(relDoc)).toBe(true);

        await absDoc.set({ ok: true });
        const s = await relDoc.get();
        const d = s.data() as DocumentData;
        expect(d.ok).toBe(true);

        // Formatting
        expect(relCol.path).toBe(`${COLLECTION_ID}/abs/branch`);
        expect(relDoc.path).toBe(`${COLLECTION_ID}/abs/branch/leaf`);
        expect(relDoc.parent.isEqual(relCol)).toBe(true);
        expect(relDoc.id).toBe('leaf');
      });
    });

    describe('Invalid IDs / path parity validation', () => {
      it('rejects empty document IDs', () => {
        const col = Firestore.collection(COLLECTION_ID)
          .doc('invalid')
          .collection('ids');
        // Synchronous construction error
        ExpectError.inline(() => col.doc(''), {
          match:
            /Value for argument "documentPath" is not a valid resource path. Path must be a non-empty string./i,
        });
      });

      it('Firestore.collection(path) requires an odd number of segments (collection paths only)', () => {
        // Even segments => "collection/doc" (invalid for collection())
        ExpectError.inline(
          () => Firestore.collection(`${COLLECTION_ID}/docId`),
          {
            match:
              /invalid collection reference|odd number of segments|must point to a collection/i,
          }
        );
      });

      it('Firestore.doc(path) requires an even number of segments (document paths only)', () => {
        // Odd segments => "collection" (invalid for doc())
        ExpectError.inline(() => Firestore.doc(`${COLLECTION_ID}`), {
          match:
            /invalid document reference|even number of segments|must point to a document/i,
        });
      });
    });
  });
}
