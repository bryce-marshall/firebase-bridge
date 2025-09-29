import { Firestore, Settings } from 'firebase-admin/firestore';
/**
 * Represents a context for common `FirestoreBridge` unit tests.
 */
export interface FirestoreBridgeTestContext {
  /**
   * Initializes the test context.
   *
   * If `collectionPath` is specified, recursively deletes all documents and subcollections
   * under the collection at `collectionPath` before initializing the context.
   *
   * @param collectionPath - (Optional) The root collection path to clear before initialization.
   * @returns A promise that resolves to an initialized {@link FirestoreBridge} instance.
   *
   * @example
   * ```ts
   * import { FirestoreBridge } from '@firebase-bridge/firestore-bridge';
   * import { FirestoreBridgeTestContext } from './test-context.js';
   *
   * export function pathTests(context: FirestoreBridgeTestContext) {
   *   const COLLECTION_ID = 'PathTests';
   *
   *   describe('Path Tests', () => {
   *     let Firestore: FirestoreBridge;
   *
   *     beforeAll(async () => {
   *       Firestore = await context.init(COLLECTION_ID);
   *     });
   *
   *     afterAll(async () => {
   *       await context.tearDown();
   *     });
   *
   *     it('returns the expected path', async () => {
   *       const ref = Firestore.collection(COLLECTION_ID).doc('doc1');
   *       expect(ref.path).toEqual('PathTests/doc1');
   *     });
   *   });
   * }
   * ```
   */
  init(collectionPath?: string, settings?: Settings): Promise<Firestore>;

  // reset(): Promise<Firestore>;

  /**
   * Executes teardown logic specific to the context.
   *
   * This may include waiting for any open threads or handles to close before resolving.
   *
   * @returns A promise that resolves when teardown is complete.
   *
   * @example
   * ```ts
   * import { FirestoreBridge } from '@firebase-bridge/firestore-bridge';
   * import { FirestoreBridgeTestContext } from './test-context.js';
   *
   * export function pathTests(context: FirestoreBridgeTestContext) {
   *   const COLLECTION_ID = 'PathTests';
   *
   *   describe('Path Tests', () => {
   *     let Firestore: FirestoreBridge;
   *
   *     beforeAll(async () => {
   *       Firestore = await context.init(COLLECTION_ID);
   *     });
   *
   *     afterAll(async () => {
   *       await context.tearDown();
   *     });
   *
   *     it('returns the expected path', async () => {
   *       const ref = Firestore.collection(COLLECTION_ID).doc('doc1');
   *       expect(ref.path).toEqual('PathTests/doc1');
   *     });
   *   });
   * }
   * ```
   */
  tearDown(): Promise<void>;
}
