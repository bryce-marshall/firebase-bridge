process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = 'localhost:9199';
// Increase default timeout for all production/emulator tests
jest.setTimeout(7_000);
