import {
  CloudStorageObjectEvent,
  onObjectArchived,
  onObjectDeleted,
  onObjectFinalized,
  onObjectMetadataUpdated,
} from '../index.js';

describe('Cloud Storage function wrappers', () => {
  it('normalizes finalized events and awaits async platform and handler', async () => {
    const calls: string[] = [];
    const fn = onObjectFinalized(
      {
        bucket: 'wrapper.test',
        platform: async () => {
          calls.push('platform');
          return { name: 'platform' };
        },
      },
      async (event, platform) => {
        calls.push(`handler:${platform.name}:${event.kind}:${event.path}`);
        await Promise.resolve();
      }
    );

    expect(fn.run).toBeDefined();
    await fn.run?.(eventPayload());

    expect(calls).toEqual(['platform', 'handler:platform:finalized:file.csv']);
  });

  it('maps deleted, archived, and metadata-updated wrapper kinds', async () => {
    const kinds: CloudStorageObjectEvent['kind'][] = [];
    const options = {
      bucket: 'wrapper.test',
      platform: () => ({}),
    };

    await onObjectDeleted(options, (event) => kinds.push(event.kind)).run?.(
      eventPayload()
    );
    await onObjectArchived(options, (event) => kinds.push(event.kind)).run?.(
      eventPayload()
    );
    await onObjectMetadataUpdated(options, (event) => kinds.push(event.kind)).run?.(
      eventPayload()
    );

    expect(kinds).toEqual(['deleted', 'archived', 'metadata-updated']);
  });

  it('normalizes metadata fields consistently', async () => {
    let normalized: CloudStorageObjectEvent | undefined;
    const fn = onObjectFinalized(
      {
        bucket: 'wrapper.test',
        platform: () => ({}),
      },
      (event) => {
        normalized = event;
      }
    );

    await fn.run?.(eventPayload());

    expect(normalized).toMatchObject({
      id: 'event-1',
      kind: 'finalized',
      bucketId: 'wrapper.test',
      path: 'file.csv',
      eventTime: new Date('2026-05-01T00:00:00.000Z'),
      metadata: {
        bucketId: 'wrapper.test',
        path: 'file.csv',
        name: 'file.csv',
        size: 12,
        contentType: 'text/csv',
        cacheControl: 'private',
        contentEncoding: 'identity',
        contentDisposition: 'attachment; filename="file.csv"',
        customMetadata: { importId: 'imp-001' },
        generation: '7',
        metageneration: '3',
        etag: 'etag-1',
        md5Hash: 'md5-1',
        crc32c: 'crc-1',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
        updatedAt: new Date('2026-05-01T00:01:00.000Z'),
      },
    });
  });

  it('propagates platform and handler errors to the Cloud Functions runtime', async () => {
    await expect(
      onObjectFinalized(
        {
          bucket: 'wrapper.test',
          platform: async () => {
            throw new Error('platform failed');
          },
        },
        () => undefined
      ).run?.(eventPayload())
    ).rejects.toThrow('platform failed');

    await expect(
      onObjectFinalized(
        {
          bucket: 'wrapper.test',
          platform: () => ({}),
        },
        async () => {
          throw new Error('handler failed');
        }
      ).run?.(eventPayload())
    ).rejects.toThrow('handler failed');
  });
});

function eventPayload() {
  return {
    id: 'event-1',
    time: '2026-05-01T00:00:00.000Z',
    data: {
      bucket: 'wrapper.test',
      name: 'file.csv',
      size: 12,
      contentType: 'text/csv',
      cacheControl: 'private',
      contentEncoding: 'identity',
      contentDisposition: 'attachment; filename="file.csv"',
      metadata: { importId: 'imp-001' },
      generation: 7,
      metageneration: 3,
      etag: 'etag-1',
      md5Hash: 'md5-1',
      crc32c: 'crc-1',
      timeCreated: '2026-05-01T00:00:00.000Z',
      updated: '2026-05-01T00:01:00.000Z',
    },
  };
}
