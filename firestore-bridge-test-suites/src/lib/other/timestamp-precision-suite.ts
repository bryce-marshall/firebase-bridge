import {
  DocumentData,
  Firestore,
  Timestamp
} from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from '../test-context.js';

export function timestampPrecisionSuite(context: FirestoreBridgeTestContext) {
  // Unique root collection name to avoid collisions across runs
  const COLLECTION_ID = 'Timestamp precision (microsecond truncation)';

  describe(COLLECTION_ID, () => {
    let db!: Firestore;

    beforeAll(async () => {
      db = await context.init(COLLECTION_ID);
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('truncates nanoseconds beyond microseconds on write → read', async () => {
      const seconds = 1_600_000_000;

      // One representative for each input length (0..9 digits), plus a few boundaries.
      // 0
      // 1-digit .. 9-digit
      // boundaries around 1_000 (microsecond) and 1_000_000 (millisecond)
      const inputs: number[] = [
        0,                // len 1
        5,                // len 1
        12,               // len 2
        123,              // len 3
        999,              // < 1000 boundary (floor -> 0)
        1000,             // exactly 1 microsecond (no truncation change)
        1001,             // just over microsecond (floor -> 1000)
        1234,             // len 4
        12345,            // len 5
        123456,           // len 6 (explicitly requested)
        1_000_000,        // exactly 1 millisecond (still multiple of 1000)
        1_000_001,        // just over millisecond (floor -> 1_000_000)
        1_234_567,        // len 7
        12_345_678,       // len 8
        123_456_789       // len 9
      ];

      for (const nsIn of inputs) {
        const id = `ns-${nsIn}`;
        const ref = db.collection(COLLECTION_ID).doc(id);

        const input = new Timestamp(seconds, nsIn);
        await ref.set({ ts: input });

        const snap = await ref.get();
        const d = snap.data() as DocumentData;

        expect(d.ts).toBeInstanceOf(Timestamp);
        const out = d.ts as Timestamp;

        const expected = truncatedTimestamp(seconds, nsIn);

        // Always equal to the truncated value
        expect(out.isEqual(expected)).toBe(true);
        expect(out.seconds).toBe(seconds);
        expect(out.nanoseconds).toBe(Math.floor(nsIn / 1_000) * 1_000);

        // Only equal to the original input when input nanos already a multiple of 1000
        const inputWasMicroAligned = nsIn % 1_000 === 0;
        expect(out.isEqual(input)).toBe(inputWasMicroAligned);
      }
    });
  });
}

/**
 * Creates a `Timestamp` with nanoseconds truncated in accordance with backend persistence behaviour.
 */
function truncatedTimestamp(seconds: number, nsIn: number): Timestamp {
  return new Timestamp(seconds, Math.floor(nsIn / 1_000) * 1_000);
}
