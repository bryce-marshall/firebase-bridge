/* eslint-disable @typescript-eslint/no-explicit-any */
import * as admin from 'firebase-admin';
import { Firestore, Settings } from 'firebase-admin/firestore';
import { FirestoreBridgeTestContext } from 'firestore-bridge-test-suites';

function createApp(name: string): admin.app.App {
  return admin.initializeApp(
    {
      projectId: 'default-project',
    },
    name
  );
}

/**
 * Capture the initial set of Node.js active handles when this module is first loaded.
 * This allows us to distinguish handles created by Firestore (or tests) from those that always exist.
 */
const initialHandles = getActiveHandles();

/**
 * Optionally log the emulator host if running tests against the Firestore Emulator.
 */
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(
    `*** Missing process.env.FIRESTORE_EMULATOR_HOST
    ***
    *** Ensure that \`jest.setup.js\` is present and contains  
    *** process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
    ***
    `
  );
}

interface FirestoreContext {
  firestore: Firestore;
  app: admin.app.App;
}

export function testContext(): FirestoreBridgeTestContext {
  const clients: FirestoreContext[] = [];

  return {
    async init(collectionPath?: string, settings?: Settings): Promise<Firestore> {
      const app = createApp(`app-${clients.length}`);
      const firestore = admin.firestore(app);
      if (settings) {
        firestore.settings(settings);
      }

      const context: FirestoreContext = {
        firestore,
        app,
      };
      clients.push(context);

      if (collectionPath && clients.length === 1) {
        await firestore.recursiveDelete(firestore.collection(collectionPath));
      }

      return firestore;
    },
    async tearDown(): Promise<void> {
      let context = clients.pop();
      while (context) {
        await teardownTestSuite(context.firestore, context.app);
        context = clients.pop();
      }
    },
  };
  // return TestContext;
}

/**
 * Prepares the Firestore test suite by deleting all documents from the specified collection.
 * This ensures a clean state for each test run.
 *
 * @param collectionId The ID of the collection to clear before tests run.
 */
export async function initTestSuite(
  firestore: Firestore,
  collectionId: string
): Promise<void> {
  // Remove all documents in the test collection before each suite.
  await firestore.recursiveDelete(firestore.collection(collectionId));
}

/**
 * Cleans up after the test suite by:
 *   1. Terminating the Firestore client (closing any open sockets/timers).
 *   2. Deleting the Firebase Admin app (frees all SDK resources).
 *   3. Polling for any remaining open Node.js handles, waiting up to 5 seconds.
 *      This helps avoid Jest "open handles" warnings, especially with the emulator.
 *
 * Any leftover handles are logged as a warning for debugging.
 */
export async function teardownTestSuite(
  firestore: Firestore,
  app: admin.app.App
): Promise<void> {
  // Terminate Firestore client to close background connections/timers.
  await firestore.terminate();

  // Delete the Firebase app to free all resources allocated by the SDK.
  await app.delete();

  // Wait until all handles created during tests are gone (max 5 seconds).
  // Helps mitigate "open handle" warnings in Jest (especially on Windows/emulator).
  const timeoutMs = 5000;
  const pollMs = 100;
  const start = Date.now();
  while (extraHandles().length > 0 && Date.now() - start < timeoutMs) {
    await new Promise((res) => setTimeout(res, pollMs));
  }

  // Log leftover handles for further debugging if any remain.
  const leftovers = extraHandles();
  if (leftovers.length > 0) {
    console.warn('Warning: open handles after teardown:', leftovers);
  }
}

/**
 * Returns a shallow copy of currently active Node.js handles.
 * These include timers, sockets, streams, etc. Used to detect resource leaks.
 */
function getActiveHandles(): any[] {
  return (process as any)?._getActiveHandles().slice();
}

/**
 * Computes the set of handles that have been added since the initial module load.
 * This helps identify handles that may have leaked during testing.
 */
function extraHandles() {
  const current = getActiveHandles();
  return current.filter((h) => !initialHandles.includes(h));
}
