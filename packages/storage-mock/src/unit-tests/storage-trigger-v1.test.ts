import * as v1 from 'firebase-functions/v1';
import { StorageMock } from '../index.js';
import { StorageTriggerErrorOrigin } from '../lib/types.js';
import { registerTrigger } from '../lib/v1/index.js';

describe('StorageMock v1 direct trigger registration', () => {
  it('invokes finalized, deleted, and metadata-update handlers with realistic payloads', async () => {
    const ctrl = new StorageMock({
      now: () => Date.parse('2026-03-01T00:00:00.000Z'),
    }).createStorage({ defaultBucket: 'v1.test' });
    const bucket = ctrl.service().bucket();
    const calls: string[] = [];
    const contexts: unknown[] = [];
    const payloads: unknown[] = [];

    const disposeFinalize = registerTrigger(
      ctrl,
      v1.storage.bucket('v1.test').object().onFinalize((object, context) => {
        calls.push(`finalized:${object.bucket}:${object.name}:${object.size}`);
        payloads.push(object);
        contexts.push(context);
      })
    );
    const disposeDelete = registerTrigger(
      ctrl,
      v1.storage.bucket('v1.test').object().onDelete((object, context) => {
        calls.push(`deleted:${object.name}:${context.eventType}`);
      })
    );
    const disposeMetadata = registerTrigger(
      ctrl,
      v1.storage.bucket('v1.test').object().onMetadataUpdate((object) => {
        calls.push(`metadata:${object.name}:${object.contentType}`);
      })
    );
    const disposeArchive = registerTrigger(
      ctrl,
      v1.storage.bucket('v1.test').object().onArchive((object) => {
        calls.push(`archived:${object.name}`);
      })
    );

    await bucket.writeText('file.csv', 'a,b\n', {
      metadata: {
        contentType: 'text/csv',
        customMetadata: { importId: 'imp-001' },
      },
    });
    await bucket.setMetadata('file.csv', { cacheControl: 'private' });
    await bucket.delete('file.csv');
    await flush();

    expect(calls).toEqual([
      'finalized:v1.test:file.csv:4',
      'metadata:file.csv:text/csv',
      'deleted:file.csv:google.storage.object.delete',
    ]);
    expect(payloads[0]).toMatchObject({
      kind: 'storage#object',
      id: 'v1.test/file.csv/1',
      bucket: 'v1.test',
      storageClass: 'STANDARD',
      name: 'file.csv',
      size: '4',
      contentType: 'text/csv',
      metadata: { importId: 'imp-001' },
    });
    expect(contexts[0]).toMatchObject({
      eventId: '0:v1.test:file.csv:1:1:finalized',
      eventType: 'google.storage.object.finalize',
      timestamp: '2026-03-01T00:00:00.000Z',
      params: {},
      resource: {
        service: 'storage.googleapis.com',
        name: 'projects/_/buckets/v1.test/objects/file.csv#1',
      },
    });

    disposeFinalize();
    disposeDelete();
    disposeMetadata();
    disposeArchive();
  });

  it('honors bucket filters, predicates, predicate errors, and disposer unregister', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v1.test' });
    const bucket = ctrl.service().bucket();
    const other = ctrl.service().bucket('other.test');
    const calls: string[] = [];
    const errors: unknown[] = [];

    const dispose = registerTrigger(
      ctrl,
      v1.storage.bucket('v1.test').object().onFinalize((object) => {
        calls.push(object.name ?? '');
      }),
      {
        predicate(record) {
          if (record.path === 'throw.csv') throw new Error('predicate failed');
          return record.path.endsWith('.csv');
        },
        onError(arg) {
          errors.push(arg);
        },
      }
    );

    await bucket.writeText('skip.txt', 'skip');
    await bucket.writeText('keep.csv', 'keep');
    await other.writeText('other.csv', 'other');
    await bucket.writeText('throw.csv', 'throw');
    await flush();

    expect(calls).toEqual(['keep.csv']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      origin: StorageTriggerErrorOrigin.Predicate,
      arg: { path: 'throw.csv' },
    });

    dispose();
    await bucket.writeText('after-dispose.csv', 'after');
    await flush();
    expect(calls).toEqual(['keep.csv']);
  });

  it('allows duplicate direct registration of the same function', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v1.test' });
    const bucket = ctrl.service().bucket();
    const calls: string[] = [];
    const fn = v1.storage.bucket('v1.test').object().onFinalize((object) => {
      calls.push(object.name ?? '');
    });

    const disposeOne = registerTrigger(ctrl, fn);
    const disposeTwo = registerTrigger(ctrl, fn);
    await bucket.writeText('duplicate.csv', 'duplicate');
    await flush();

    expect(calls).toEqual(['duplicate.csv', 'duplicate.csv']);

    disposeOne();
    disposeTwo();
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
