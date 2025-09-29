import { GapicClient } from '@google-cloud/firestore/build/src/types';
import { Firestore } from 'firebase-admin/firestore';
import { ClientPool } from '../../../../lib/_internal/firestore/pool';
import { GapicContext } from '../../../../lib/_internal/mock-gapic-client/gapic-context';
import { MockGapicClient } from '../../../../lib/_internal/mock-gapic-client/mock-gapic-client';
import { FirestoreMock } from '../../../../lib/controller';
import { DatabaseDirect } from '../../../../lib/database-direct';
import { SystemTime } from '../../../../lib/system-time';

export const MOCK_PROJECT_ID = 'project-one';

export interface MakeGapicClientConfig {
  database?: string;
}

export interface MockGapicTestContext {
  client: MockGapicClient;
  context: GapicContext;
  db: DatabaseDirect;
  time: SystemTime;
  firestore: Firestore;
}

export function mockGapicTestContext(
  config?: MakeGapicClientConfig
): MockGapicTestContext {
  const env = new FirestoreMock();
  const ctr = env.createDatabase(MOCK_PROJECT_ID, config?.database);
  const firestore = ctr.firestore();
  const clientPool = (firestore as unknown as WithClientPool)._clientPool;
  let client!: MockGapicClient;
  // Ensure that the `GapicClient` instance is available (completes synchronously).
  clientPool.run('imock', false, (gapicClient) => {
    client = gapicClient as MockGapicClient;
    return Promise.resolve();
  });

  return {
    firestore,
    client,
    context: client.context,
    db: ctr.database,
    time: env.systemTime,
  };
}

interface WithClientPool {
  /**
   * The internal pool the Admin SDK uses to create/reuse GAPIC clients.
   * `FirestoreMock` replaces or rebinds this pool so it returns
   * `MockGapicClient` instances (in-memory, no network).
   */
  _clientPool: ClientPool<GapicClient>;
}
