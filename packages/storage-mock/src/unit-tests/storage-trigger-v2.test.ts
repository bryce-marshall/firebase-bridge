import {
  onObjectArchived,
  onObjectDeleted,
  onObjectFinalized,
  onObjectMetadataUpdated,
} from 'firebase-functions/v2/storage';
import { StorageMock } from '../index.js';
import { StorageTriggerErrorOrigin } from '../lib/types.js';
import { registerTrigger } from '../lib/v2/index.js';

describe('StorageMock v2 direct trigger registration', () => {
  it('invokes finalized, deleted, and metadata-update handlers with realistic CloudEvents', async () => {
    const ctrl = new StorageMock({
      now: () => Date.parse('2026-04-01T00:00:00.000Z'),
    }).createStorage({ defaultBucket: 'v2.test' });
    const bucket = ctrl.service().bucket();
    const calls: string[] = [];
    const events: unknown[] = [];

    const disposeFinalize = registerTrigger(
      ctrl,
      onObjectFinalized({ bucket: 'v2.test' }, (event) => {
        calls.push(`finalized:${event.bucket}:${event.data.name}`);
        events.push(event);
      })
    );
    const disposeDelete = registerTrigger(
      ctrl,
      onObjectDeleted({ bucket: 'v2.test' }, (event) => {
        calls.push(`deleted:${event.data.name}:${event.type}`);
      })
    );
    const disposeMetadata = registerTrigger(
      ctrl,
      onObjectMetadataUpdated({ bucket: 'v2.test' }, (event) => {
        calls.push(`metadata:${event.data.name}:${event.data.contentType}`);
      })
    );
    const disposeArchive = registerTrigger(
      ctrl,
      onObjectArchived({ bucket: 'v2.test' }, (event) => {
        calls.push(`archived:${event.data.name}`);
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
      'finalized:v2.test:file.csv',
      'metadata:file.csv:text/csv',
      'deleted:file.csv:google.cloud.storage.object.v1.deleted',
    ]);
    expect(events[0]).toMatchObject({
      id: '0:v2.test:file.csv:1:1:finalized',
      source: '//storage.googleapis.com/projects/_/buckets/v2.test',
      subject: 'objects/file.csv',
      type: 'google.cloud.storage.object.v1.finalized',
      time: '2026-04-01T00:00:00.000Z',
      bucket: 'v2.test',
      specversion: '1.0',
      data: {
        bucket: 'v2.test',
        name: 'file.csv',
        generation: 1,
        metageneration: 1,
        contentType: 'text/csv',
        size: 4,
        timeCreated: '2026-04-01T00:00:00.000Z',
        updated: '2026-04-01T00:00:00.000Z',
        metadata: { importId: 'imp-001' },
      },
    });

    disposeFinalize();
    disposeDelete();
    disposeMetadata();
    disposeArchive();
  });

  it('honors bucket filters, predicates, predicate errors, and disposer unregister', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v2.test' });
    const bucket = ctrl.service().bucket();
    const other = ctrl.service().bucket('other.test');
    const calls: string[] = [];
    const errors: unknown[] = [];

    const dispose = registerTrigger(
      ctrl,
      onObjectFinalized({ bucket: 'v2.test' }, (event) => {
        calls.push(event.data.name);
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

  it('evaluates predicates only after kind and bucket matching', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v2.test' });
    const bucket = ctrl.service().bucket();
    const other = ctrl.service().bucket('other.test');
    const predicatePaths: string[] = [];
    const calls: string[] = [];

    registerTrigger(
      ctrl,
      onObjectFinalized({ bucket: 'v2.test' }, (event) => {
        calls.push(event.data.name);
      }),
      (record) => {
        predicatePaths.push(record.path);
        return true;
      }
    );

    await other.writeText('other.csv', 'other');
    await bucket.writeText('file.csv', 'file');
    await bucket.setMetadata('file.csv', { cacheControl: 'private' });
    await bucket.delete('file.csv');
    await flush();

    expect(predicatePaths).toEqual(['file.csv']);
    expect(calls).toEqual(['file.csv']);
  });

  it('allows duplicate direct registration of the same function', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v2.test' });
    const bucket = ctrl.service().bucket();
    const calls: string[] = [];
    const fn = onObjectFinalized({ bucket: 'v2.test' }, (event) => {
      calls.push(event.data.name);
    });

    const disposeOne = registerTrigger(ctrl, fn);
    const disposeTwo = registerTrigger(ctrl, fn);
    await bucket.writeText('duplicate.csv', 'duplicate');
    await flush();

    expect(calls).toEqual(['duplicate.csv', 'duplicate.csv']);

    disposeOne();
    disposeTwo();
  });

  it('queues matching trigger deliveries and runs them in order', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v2.test' });
    const bucket = ctrl.service().bucket();
    const first = deferred();
    const second = deferred();
    const secondStarted = deferred();
    const completed = deferred();
    const calls: string[] = [];

    registerTrigger(
      ctrl,
      onObjectFinalized({ bucket: 'v2.test' }, async (event) => {
        calls.push(`start:${event.data.name}`);
        if (event.data.name === 'first.csv') {
          await first.promise;
        } else {
          secondStarted.resolve();
          await second.promise;
        }
        calls.push(`end:${event.data.name}`);
        if (event.data.name === 'second.csv') completed.resolve();
      })
    );

    const writeFirst = bucket.writeText('first.csv', 'first');
    expect(calls).toEqual([]);
    await writeFirst;
    expect(calls).toEqual(['start:first.csv']);

    await bucket.writeText('second.csv', 'second');
    await drainMicrotasks();
    expect(calls).toEqual(['start:first.csv']);

    first.resolve();
    await secondStarted.promise;
    expect(calls).toEqual([
      'start:first.csv',
      'end:first.csv',
      'start:second.csv',
    ]);

    second.resolve();
    await completed.promise;
    expect(calls).toEqual([
      'start:first.csv',
      'end:first.csv',
      'start:second.csv',
      'end:second.csv',
    ]);
  });

  it('reports handler errors through onError and swallows onError failures', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'v2.test' });
    const bucket = ctrl.service().bucket();
    const errors: unknown[] = [];

    registerTrigger(
      ctrl,
      onObjectFinalized({ bucket: 'v2.test' }, () => {
        throw new Error('handler failed');
      }),
      {
        onError(arg) {
          errors.push(arg);
          throw new Error('error watcher failed');
        },
      }
    );

    await bucket.writeText('handler-error.csv', 'error');
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      origin: StorageTriggerErrorOrigin.Execute,
      arg: { path: 'handler-error.csv' },
    });
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: resolveFn,
  };
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
