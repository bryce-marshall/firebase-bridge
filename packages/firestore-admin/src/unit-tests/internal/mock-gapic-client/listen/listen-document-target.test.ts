/* eslint-disable @typescript-eslint/no-explicit-any */
import { Status } from 'google-gax';
import { Duplex } from 'stream';
import { MockGapicClient } from '../../../../lib/_internal/mock-gapic-client/mock-gapic-client';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';
import { google } from '../test-utils/google';

function createListenStream(client: MockGapicClient): Duplex {
  const stream = client.listen();
  // Ensure async events are flushed in mock environment
  stream.on('error', (err: MockGapicClient) => {
    throw err;
  });

  return stream;
}

describe('MockGapicClient.listen', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'ListenDB' });
  });

  afterEach(async () => {
    await Mock.firestore.terminate();
  });

  it('sends initial snapshot for existing document target', async () => {
    const docPath = 'users/alice';
    Mock.db.setDocument(docPath, { name: 'Alice' });

    const stream = createListenStream(Mock.client);
    const done = waitForData(stream, 2);

    stream.write({
      addTarget: {
        targetId: 1,
        documents: { documents: [Mock.context.toGapicPath(docPath)] },
      },
    });

    const responses = await done;

    expect(responses.some((r) => r.documentChange != undefined)).toBe(true);
  });

  it('streams documentDelete when subscribed document is deleted', async () => {
    const docPath = 'users/carl';
    Mock.db.setDocument(docPath, { active: true });

    const stream = createListenStream(Mock.client);

    // Wait for the delete event (1 event where resp.documentDelete exists)
    const deletePromise = waitForData<google.firestore.v1.IListenResponse>(
      stream,
      1,
      (resp) => !!resp.documentDelete
    );

    // Subscribe to document
    stream.write({
      addTarget: {
        targetId: 3,
        documents: { documents: [Mock.context.toGapicPath(docPath)] },
      },
    });

    await waitForData(stream, 1); // Wait for initial add/change event
    Mock.db.deleteDocument(docPath);

    const deletes = await deletePromise;
    expect(deletes.length).toBeGreaterThan(0);
  });

  it('removes target and stops sending updates', async () => {
    const docPath = 'users/dan';
    Mock.db.setDocument(docPath, { score: 10 });

    const stream = createListenStream(Mock.client);

    const initialChange = waitForData(
      stream,
      1,
      (resp) => !!resp.documentChange
    );

    stream.write({
      addTarget: {
        targetId: 4,
        documents: { documents: [Mock.context.toGapicPath(docPath)] },
      },
    });

    await initialChange;
    stream.write({ removeTarget: 4 });

    const afterRemoval = waitForData(
      stream,
      1,
      (resp) => !!resp.documentChange
    );

    Mock.db.setDocument(docPath, { score: 20 });

    // Give time for any unexpected change events
    const changesAfterRemoval = await Promise.race([
      afterRemoval,
      new Promise<google.firestore.v1.IListenResponse[]>((resolve) =>
        setTimeout(() => resolve([]), 50)
      ),
    ]);

    expect(changesAfterRemoval.length).toBe(0);
  });

  it('rejects with INVALID_ARGUMENT for invalid document path', async () => {
    const stream = Mock.client.listen();

    const errorPromise = new Promise<any>((resolve) =>
      stream.on('error', (err) => {
        resolve(err);
      })
    );

    try {
      stream.write({
        addTarget: {
          targetId: 5,
          documents: {
            documents: ['projects/p1/databases/(default)/documents'],
          },
        },
      });
    } catch {
      console.log('Error forwarded');
    }

    const err: any = await errorPromise;
    expect(err.code).toBe(Status.INVALID_ARGUMENT);
  });

  it('streams updates for multiple document targets in one addTarget', async () => {
    const docPath1 = 'users/alpha';
    const docPath2 = 'users/bravo';
    Mock.db.setDocument(docPath1, { name: 'Alpha', score: 1 });
    Mock.db.setDocument(docPath2, { name: 'Bravo', score: 2 });

    const stream = createListenStream(Mock.client);

    // Wait for the two initial change events (one per document)
    const initialChanges = waitForData(
      stream,
      2,
      (resp) => !!resp.documentChange
    );

    // Add both documents to one target
    stream.write({
      addTarget: {
        targetId: 10,
        documents: {
          documents: [
            Mock.context.toGapicPath(docPath1),
            Mock.context.toGapicPath(docPath2),
          ],
        },
      },
    });

    const init = await initialChanges;
    expect(init.length).toBe(2);

    // Now update both docs and expect changes for each
    const updateChanges = waitForData(
      stream,
      2,
      (resp) => !!resp.documentChange
    );

    Mock.db.setDocument(docPath1, { name: 'Alpha', score: 5 });
    Mock.db.setDocument(docPath2, { name: 'Bravo', score: 8 });

    const updates = await updateChanges;
    expect(updates.length).toBe(2);
    expect(
      updates.every((u) => u.documentChange?.document?.fields != null)
    ).toBe(true);

    // Finally delete both docs and expect delete events for each
    const deleteEvents = waitForData(
      stream,
      2,
      (resp) => !!resp.documentDelete
    );

    Mock.db.deleteDocument(docPath1);
    Mock.db.deleteDocument(docPath2);

    const deletes = await deleteEvents;
    expect(deletes.length).toBe(2);
  });
});

function waitForData<T extends google.firestore.v1.IListenResponse>(
  stream: Duplex,
  count: number,
  filter?: (resp: google.firestore.v1.IListenResponse) => boolean
): Promise<T[]> {
  return new Promise((resolve) => {
    const results: T[] = [];
    stream.on('data', (resp) => {
      if (!filter || filter(resp)) {
        results.push(resp as T);
        if (results.length >= count) {
          resolve(results);
        }
      }
    });
  });
}
