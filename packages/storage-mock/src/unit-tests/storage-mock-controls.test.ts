import { CloudStorageError } from '@firebase-bridge/cloud-storage';
import { StorageMock } from '../index.js';

describe('StorageMock test controls and events', () => {
  it('uses configured time sources for metadata, events, and operation logs', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const env = new StorageMock({ now: () => now });
    const ctrl = env.createStorage({ defaultBucket: 'time.test' });
    const bucket = ctrl.service().bucket();
    const events: Date[] = [];
    ctrl.onObjectChange((record) => events.push(record.eventTime));

    const first = await bucket.writeText('clock.txt', 'one');
    expect(first.metadata.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(events[0].toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(ctrl.getOperationLog()[0].at.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );

    ctrl.setClock(() => Date.parse('2026-01-01T00:01:00.000Z'));
    const updated = await bucket.setMetadata('clock.txt', {
      cacheControl: 'private',
    });
    expect(updated.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(updated.updatedAt.toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(events[1].toISOString()).toBe('2026-01-01T00:01:00.000Z');

    ctrl.setClock({ now: () => Date.parse('2026-01-01T00:02:00.000Z') });
    await bucket.writeText('clock-2.txt', 'two');
    expect(events[2].toISOString()).toBe('2026-01-01T00:02:00.000Z');

    const other = env.createStorage({ defaultBucket: 'time.other' });
    now = Date.parse('2026-01-01T00:03:00.000Z');
    const otherWrite = await other.service().bucket().writeText('shared.txt', 'x');
    expect(otherWrite.metadata.createdAt.toISOString()).toBe(
      '2026-01-01T00:03:00.000Z'
    );
  });

  it('defaults time to the current epoch milliseconds', async () => {
    const before = Date.now();
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'time.test' });
    const write = await ctrl.service().bucket().writeText('now.txt', 'now');
    const after = Date.now();

    expect(write.metadata.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(write.metadata.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('emits lifecycle events with metadata snapshots only after successful operations', async () => {
    const ctrl = new StorageMock({
      now: () => Date.parse('2026-02-01T00:00:00.000Z'),
    }).createStorage({ defaultBucket: 'events.test' });
    const bucket = ctrl.service().bucket();
    const events = [];
    ctrl.onObjectChange((record) => events.push(record));

    const first = await bucket.writeText('file.txt', 'one');
    await bucket.writeText('file.txt', 'two');
    await expect(
      bucket.writeText('file.txt', 'nope', {
        precondition: { type: 'does-not-exist' },
      })
    ).rejects.toMatchObject({ code: 'storage/precondition-failed' });
    await bucket.setMetadata('file.txt', { contentType: 'text/plain' });
    await bucket.delete('file.txt');
    await bucket.delete('file.txt', { ignoreMissing: true });

    expect(events.map((event) => event.kind)).toEqual([
      'finalized',
      'finalized',
      'metadata-updated',
      'deleted',
    ]);
    expect(events[0]).toMatchObject({
      id: '0:events.test:file.txt:1:1:finalized',
      epoch: 0,
      bucketId: 'events.test',
      path: 'file.txt',
      metadata: { generation: first.metadata.generation },
    });
    expect(events[0].previousMetadata).toBeUndefined();
    expect(events[1].previousMetadata).toMatchObject({ generation: '1' });
    expect(events[2].previousMetadata).toMatchObject({ generation: '2' });
    expect(events[3].previousMetadata).toMatchObject({ generation: '2' });
    expect(events.every((event) => event.eventTime instanceof Date)).toBe(true);
  });

  it('records operation logs and clears them on request', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'logs.test' });
    const bucket = ctrl.service().bucket();

    ctrl.seedObject('logs.test', 'seed.txt', 'seed');
    await bucket.exists('seed.txt');
    await bucket.read('seed.txt');
    await bucket.getMetadata('seed.txt');
    await bucket.setMetadata('seed.txt', { cacheControl: 'private' });
    await bucket.list();
    await bucket.createSignedReadUrl('seed.txt', {
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    await bucket.writeText('write.txt', 'write');
    await bucket.delete('write.txt');
    ctrl.deleteObject('logs.test', 'seed.txt');

    expect(ctrl.getOperationLog().map((record) => record.operation)).toEqual([
      'seed',
      'exists',
      'read',
      'getMetadata',
      'setMetadata',
      'list',
      'signedUrl',
      'write',
      'delete',
      'testDelete',
    ]);

    await expect(bucket.read('missing.txt')).rejects.toMatchObject({
      code: 'storage/object-not-found',
    });
    expect(ctrl.getOperationLog().some((record) => record.path === 'missing.txt')).toBe(
      false
    );

    ctrl.clearOperationLog();
    expect(ctrl.getOperationLog()).toEqual([]);
  });

  it('keeps test-control snapshots immutable from stored objects and quiet for events', () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'controls.test' });
    const events: string[] = [];
    ctrl.onObjectChange((record) => events.push(record.kind));

    ctrl.seedObject('controls.test', 'snapshot.txt', new Uint8Array([65]));
    const snapshot = ctrl.getObject('controls.test', 'snapshot.txt');
    expect(snapshot).toBeDefined();
    if (!snapshot) throw new Error('Expected seeded snapshot.');
    expect(snapshot.data[0]).toBe(65);
    snapshot.data[0] = 66;

    expect(ctrl.getObjectText('controls.test', 'snapshot.txt')).toBe('A');
    expect(ctrl.deleteObject('controls.test', 'snapshot.txt')).toBe(true);
    expect(ctrl.deleteObject('controls.test', 'snapshot.txt')).toBe(false);
    expect(events).toEqual([]);
  });

  it('resets and deletes bucket state while preserving usable controllers', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'reset.test' });
    const bucket = ctrl.service().bucket();

    await bucket.writeText('one.txt', 'one');
    const initialEpoch = ctrl.epoch;
    ctrl.reset('reset.test');
    expect(ctrl.epoch).toBe(initialEpoch + 1);
    expect(ctrl.listObjects('reset.test')).toEqual([]);

    await bucket.writeText('two.txt', 'two');
    ctrl.resetAll();
    expect(ctrl.listObjects()).toEqual([]);

    await bucket.writeText('three.txt', 'three');
    ctrl.delete('reset.test');
    expect(ctrl.listObjects('reset.test')).toEqual([]);

    await bucket.writeText('four.txt', 'four');
    ctrl.deleteAll();
    expect(ctrl.listObjects()).toEqual([]);
  });

  it('injects scoped failures without side effects or events', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'fail.test' });
    const bucket = ctrl.service().bucket();
    const otherBucket = ctrl.service().bucket('other.test');
    const events: string[] = [];
    ctrl.onObjectChange((record) => events.push(record.kind));

    await bucket.writeText('file.txt', 'one');
    events.length = 0;

    ctrl.failNext({ operation: 'write', path: 'file.txt' });
    await expect(bucket.readText('file.txt')).resolves.toBe('one');
    await expect(bucket.writeText('file.txt', 'two')).rejects.toBeInstanceOf(
      CloudStorageError
    );
    await expect(bucket.readText('file.txt')).resolves.toBe('one');
    expect(events).toEqual([]);

    ctrl.failNext({ operation: 'read', bucketId: 'fail.test' });
    await expect(otherBucket.read('file.txt')).rejects.toMatchObject({
      code: 'storage/object-not-found',
    });
    await expect(bucket.read('file.txt')).rejects.toMatchObject({
      code: 'storage/unavailable',
    });

    ctrl.failNext({
      operation: 'delete',
      path: 'file.txt',
      code: 'storage/permission-denied',
      message: 'custom failure',
    });
    await expect(bucket.delete('file.txt')).rejects.toMatchObject({
      code: 'storage/permission-denied',
      message: 'custom failure',
    });
    await expect(bucket.readText('file.txt')).resolves.toBe('one');
    expect(events).toEqual([]);
  });

  it('does not consume unmatched failure rules and logs injected failures', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'fail.test' });
    const bucket = ctrl.service().bucket();
    await bucket.writeText('file.txt', 'one');
    ctrl.clearOperationLog();

    ctrl.failNext({ operation: 'delete', path: 'file.txt' });
    await expect(bucket.readText('file.txt')).resolves.toBe('one');
    expect(ctrl.getOperationLog().map((record) => record.operation)).toEqual([
      'read',
    ]);

    await expect(bucket.delete('file.txt')).rejects.toMatchObject({
      code: 'storage/unavailable',
    });
    expect(ctrl.getOperationLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'delete',
          path: 'file.txt',
          success: false,
          errorCode: 'storage/unavailable',
        }),
      ])
    );
    await expect(bucket.readText('file.txt')).resolves.toBe('one');
  });

  it('generates deterministic mock signed read URLs for the same object and expiry', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'signed.test' });
    const bucket = ctrl.service().bucket();
    const expiresAt = new Date('2026-01-02T00:00:00.000Z');
    await bucket.writeText('folder/file name.txt', 'signed');

    const first = await bucket.createSignedReadUrl('folder/file name.txt', {
      expiresAt,
    });
    const second = await bucket.object('folder/file name.txt').createSignedReadUrl({
      expiresAt,
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      url: 'https://storage-mock.local/signed.test/folder%2Ffile%20name.txt?expires=1767312000000',
      expiresAt,
    });
  });

  it('leaves metadata unchanged after injected metadata failures', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'fail.test' });
    const bucket = ctrl.service().bucket();

    const write = await bucket.writeText('meta.txt', 'one', {
      metadata: { contentType: 'text/plain' },
    });
    ctrl.failNext({ operation: 'setMetadata', path: 'meta.txt' });

    await expect(
      bucket.setMetadata('meta.txt', { contentType: 'text/csv' })
    ).rejects.toMatchObject({ code: 'storage/unavailable' });
    await expect(bucket.getMetadata('meta.txt')).resolves.toMatchObject({
      generation: write.metadata.generation,
      metageneration: write.metadata.metageneration,
      contentType: 'text/plain',
    });
  });
});
