import * as v1 from 'firebase-functions/v1';
import {
  onObjectDeleted,
  onObjectFinalized,
  onObjectMetadataUpdated,
} from 'firebase-functions/v2/storage';
import { CloudStorageError } from '@firebase-bridge/cloud-storage';
import { StorageMock, StorageTriggerOrchestrator } from '../index.js';
import { registerTrigger as registerV1 } from '../lib/v1/index.js';
import { registerTrigger as registerV2 } from '../lib/v2/index.js';

describe('StorageMock', () => {
  it('supports object lifecycle operations through bucket and object handles', async () => {
    const env = new StorageMock({
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
    const ctrl = env.createStorage({ defaultBucket: 'imports.test' });
    const bucket = ctrl.service().bucket();

    const write = await bucket.writeText('a/file.txt', 'hello', {
      metadata: {
        contentType: 'text/plain',
        customMetadata: { userId: 'u1' },
      },
      precondition: { type: 'does-not-exist' },
    });

    expect(write.metadata.generation).toBe('1');
    expect(write.metadata.metageneration).toBe('1');
    expect(await bucket.exists('a/file.txt')).toBe(true);
    expect(await bucket.readText('a/file.txt')).toBe('hello');

    const object = bucket.object('a/file.txt');
    const updated = await object.setMetadata({
      cacheControl: 'private, max-age=60',
    });
    expect(updated.generation).toBe(write.metadata.generation);
    expect(updated.metageneration).toBe('2');
    expect(updated.customMetadata.userId).toBe('u1');

    await object.writeText('goodbye', {
      precondition: {
        type: 'generation-match',
        generation: updated.generation,
      },
    });
    expect((await object.getMetadata()).generation).toBe('2');
    expect(await object.readText()).toBe('goodbye');

    await expect(
      object.writeText('nope', { precondition: { type: 'does-not-exist' } })
    ).rejects.toMatchObject({ code: 'storage/precondition-failed' });

    const deleted = await object.delete();
    expect(deleted.deleted).toBe(true);
    await expect(object.read()).rejects.toMatchObject({
      code: 'storage/object-not-found',
    });
    await expect(object.delete({ ignoreMissing: true })).resolves.toMatchObject({
      deleted: false,
    });
  });

  it('lists deterministically with prefix and pagination', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'b.test' });
    const bucket = ctrl.service().bucket();
    await bucket.writeText('c.txt', 'c');
    await bucket.writeText('a/1.txt', 'a1');
    await bucket.writeText('a/2.txt', 'a2');

    const page1 = await bucket.list({ prefix: 'a/', pageSize: 1 });
    expect(page1.objects.map((m) => m.path)).toEqual(['a/1.txt']);
    expect(page1.nextPageToken).toBe('1');

    const page2 = await bucket.list({
      prefix: 'a/',
      pageSize: 1,
      pageToken: page1.nextPageToken,
    });
    expect(page2.objects.map((m) => m.path)).toEqual(['a/2.txt']);
    expect(page2.nextPageToken).toBeUndefined();
  });

  it('supports test controls, operation logs, reset/delete, signed URLs, and failure injection', async () => {
    const env = new StorageMock();
    const ctrl = env.createStorage({ defaultBucket: 'b.test' });
    const bucket = ctrl.service().bucket();

    ctrl.seedObject('b.test', 'seed.txt', 'seeded');
    expect(ctrl.getObjectText('b.test', 'seed.txt')).toBe('seeded');
    expect(await bucket.createSignedReadUrl('seed.txt', {
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    })).toMatchObject({
      url: 'https://storage-mock.local/b.test/seed.txt?expires=1767312000000',
    });

    ctrl.failNext({ operation: 'read', path: 'seed.txt' });
    await expect(bucket.read('seed.txt')).rejects.toBeInstanceOf(
      CloudStorageError
    );
    expect(ctrl.getOperationLog().some((op) => op.success === false)).toBe(true);

    ctrl.reset('b.test');
    expect(ctrl.hasObject('b.test', 'seed.txt')).toBe(false);
    ctrl.delete('missing.test');
    ctrl.deleteAll();
    expect(ctrl.listObjects()).toEqual([]);
  });

  it('emits object lifecycle events only after successful operations', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'b.test' });
    const bucket = ctrl.service().bucket();
    const seen: string[] = [];
    ctrl.onObjectChange((record) => seen.push(record.kind));

    await bucket.writeText('file.txt', 'one');
    await expect(
      bucket.writeText('file.txt', 'two', {
        precondition: { type: 'does-not-exist' },
      })
    ).rejects.toMatchObject({ code: 'storage/precondition-failed' });
    await bucket.setMetadata('file.txt', { contentType: 'text/plain' });
    await bucket.delete('file.txt');
    await bucket.delete('file.txt', { ignoreMissing: true });

    expect(seen).toEqual(['finalized', 'metadata-updated', 'deleted']);
  });

  it('registers v1 and v2 storage triggers with bucket scoping and predicates', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'b.test' });
    const bucket = ctrl.service().bucket('b.test');
    const other = ctrl.service().bucket('other.test');
    const calls: string[] = [];

    const disposeV1 = registerV1(
      ctrl,
      v1.storage.bucket('b.test').object().onFinalize((object, context) => {
        calls.push(`v1:${object.bucket}:${object.name}:${context.eventType}`);
      }),
      (record) => record.path.endsWith('.csv')
    );
    const disposeV2 = registerV2(
      ctrl,
      onObjectFinalized({ bucket: 'b.test' }, (event) => {
        calls.push(`v2:${event.bucket}:${event.data.name}:${event.type}`);
      })
    );

    await bucket.writeText('file.txt', 'txt');
    await bucket.writeText('file.csv', 'csv');
    await other.writeText('other.csv', 'csv');
    await new Promise((resolve) => setTimeout(resolve, 10));

    disposeV1();
    disposeV2();

    expect(calls).toEqual([
      'v2:b.test:file.txt:google.cloud.storage.object.v1.finalized',
      'v1:b.test:file.csv:google.storage.object.finalize',
      'v2:b.test:file.csv:google.cloud.storage.object.v1.finalized',
    ]);
  });

  it('orchestrates trigger enablement, waiting, suspension, reset, and errors', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'b.test' });
    const bucket = ctrl.service().bucket();
    enum Key {
      Finalized = 'Finalized',
      Deleted = 'Deleted',
      Metadata = 'Metadata',
    }

    const events: string[] = [];
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Finalized,
        onObjectFinalized({ bucket: 'b.test' }, async (event) => {
          events.push(`finalized:${event.data.name}`);
        })
      );
      reg.v2(
        Key.Deleted,
        onObjectDeleted({ bucket: 'b.test' }, async () => {
          throw new Error('delete failed');
        })
      );
      reg.v2(
        Key.Metadata,
        onObjectMetadataUpdated({ bucket: 'b.test' }, async () => {
          events.push('metadata');
        })
      );
    });

    const waiter = orchestrator.waitOne(Key.Finalized);
    await bucket.writeText('file.txt', 'data');
    await expect(waiter).resolves.toMatchObject({ completedCount: 1 });

    orchestrator.suspended = true;
    await bucket.writeText('suspended.txt', 'data');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(orchestrator.getStats(Key.Finalized).completedCount).toBe(1);
    orchestrator.suspended = false;

    const errorWaiter = orchestrator.waitOneError(Key.Deleted);
    await bucket.delete('file.txt');
    await expect(errorWaiter).resolves.toMatchObject({ errorCount: 1 });

    orchestrator.reset();
    expect(orchestrator.getStats(Key.Finalized).completedCount).toBe(0);
    const metadataWaiter = orchestrator.waitOne(Key.Metadata);
    await bucket.writeText('meta.txt', 'data');
    await bucket.setMetadata('meta.txt', { contentType: 'text/plain' });
    await expect(metadataWaiter).resolves.toMatchObject({ completedCount: 1 });

    orchestrator.disable(Key.Finalized);
    expect(orchestrator.isEnabled(Key.Finalized)).toBe(false);
    orchestrator.enable(Key.Finalized);
    expect(orchestrator.isEnabled(Key.Finalized)).toBe(true);

    orchestrator.dispose();
    expect(events).toContain('finalized:file.txt');
    expect(events).toContain('metadata');
  });

  it('rejects duplicate orchestrator keys', () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'b.test' });
    expect(
      () =>
        new StorageTriggerOrchestrator<string>(ctrl, (reg) => {
          reg.v2('same', onObjectFinalized({ bucket: 'b.test' }, () => undefined));
          reg.v2('same', onObjectFinalized({ bucket: 'b.test' }, () => undefined));
        })
    ).toThrow('Duplicate trigger key');
  });
});
