import { Firestore } from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { FirestoreMock } from '../..';
import { ExpectError, MaybeError } from '../common';

const DEFAULT_PROJECT_ID = 'default-project';
const DEFAULT_DATABASE_ID = '(default)';

describe('Mock environment tests', () => {
  let env!: FirestoreMock;
  beforeEach(() => {
    env = new FirestoreMock();
  });

  it('should create mock environment', () => {
    expect(env).toBeDefined();
    expect(env.systemTime).toBeDefined();
  });

  it('should construct a database controller', () => {
    const ctr = env.createDatabase();
    expect(ctr).toBeDefined();
    expect(ctr.database).toBeDefined();
    expect(ctr.exists()).toBe(true);
    expect(ctr.projectId).toEqual(DEFAULT_PROJECT_ID);
    expect(ctr.databaseId).toEqual(DEFAULT_DATABASE_ID);
  });

  it('should construct a firestore instance when database exists', () => {
    const ctr = env.createDatabase();
    expect(env.databaseExists()).toBe(true);
    const firestore = ctr.firestore();
    validateFirestore(firestore);
  });

  it('should construct a firestore instance when database does not exist', () => {
    expect(env.databaseExists()).toBe(false);
    const firestore = env.firestore();
    validateFirestore(firestore);
  });

  it('controller should construct different firestore instances', () => {
    const ctr = env.createDatabase();
    const firestore1 = ctr.firestore();
    validateFirestore(firestore1);
    const firestore2 = ctr.firestore();
    validateFirestore(firestore2);
    expect(firestore1).not.toBe(firestore2);
  });

  it('getDatabase() should throw if no database created', () => {
    try {
      env.getDatabase();
      fail('getDatabase() should throw');
    } catch (error) {
      ExpectError.evaluate(error as MaybeError, {
        code: Status.NOT_FOUND,
        match: /The database .* does not exist\./,
      });
    }
  });

  it('firestore operations should throw if no database created', async () => {
    const firestore = env.firestore();
    validateFirestore(firestore);
    try {
      await firestore.listCollections();
      fail('firestore operation should throw');
    } catch (error) {
      ExpectError.evaluate(error as MaybeError, {
        code: Status.NOT_FOUND,
        match: /The database .* does not exist\./,
      });
    }
  });
});

function validateFirestore(firestore: Firestore): void {
  expect(firestore).toBeDefined();
  expect(firestore.databaseId).toEqual(DEFAULT_DATABASE_ID);
}
