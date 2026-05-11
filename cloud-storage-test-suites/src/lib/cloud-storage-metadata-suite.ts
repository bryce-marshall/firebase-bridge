import type { CloudStorageBucket } from '@firebase-bridge/cloud-storage';
import { CloudStorageBridgeTestContext } from './cloud-storage-test-context.js';
import { expectObjectText, expectStorageError } from './helpers.js';

export function cloudStorageMetadataSuite(
  context: CloudStorageBridgeTestContext
) {
  describe('Cloud Storage Metadata', () => {
    let bucket!: CloudStorageBucket;

    beforeEach(async () => {
      bucket = await context.init('metadata.test');
    });

    afterEach(async () => {
      await context.tearDown();
    });

    it('round-trips write metadata fields', async () => {
      const write = await bucket.writeText('meta/object.txt', 'metadata', {
        metadata: {
          contentType: 'text/plain',
          cacheControl: 'private, max-age=60',
          contentEncoding: 'identity',
          contentDisposition: 'attachment; filename="object.txt"',
          customMetadata: {
            importId: 'imp-001',
            userId: 'u1',
          },
        },
      });

      expect(write.metadata).toMatchObject({
        bucketId: bucket.bucketId,
        path: 'meta/object.txt',
        name: 'meta/object.txt',
        size: Buffer.byteLength('metadata'),
        contentType: 'text/plain',
        cacheControl: 'private, max-age=60',
        contentEncoding: 'identity',
        contentDisposition: 'attachment; filename="object.txt"',
        customMetadata: {
          importId: 'imp-001',
          userId: 'u1',
        },
      });

      await expect(bucket.getMetadata('missing.txt')).rejects.toMatchObject({
        code: 'storage/object-not-found',
      });
    });

    it('updates metadata without changing bytes or generation', async () => {
      const write = await bucket.writeText('meta/update.txt', 'body', {
        metadata: {
          contentType: 'text/plain',
          cacheControl: 'private',
          customMetadata: { keep: 'yes' },
        },
      });

      const updated = await bucket.setMetadata('meta/update.txt', {
        cacheControl: 'public, max-age=300',
        customMetadata: { next: 'value' },
      });

      expect(updated.generation).toBe(write.metadata.generation);
      expect(Number(updated.metageneration)).toBeGreaterThan(
        Number(write.metadata.metageneration)
      );
      expect(updated.contentType).toBe('text/plain');
      expect(updated.cacheControl).toBe('public, max-age=300');
      expect(updated.customMetadata).toEqual({ keep: 'yes', next: 'value' });
      expect(updated.createdAt.getTime()).toBe(write.metadata.createdAt.getTime());
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        write.metadata.updatedAt.getTime()
      );
      await expectObjectText(bucket, 'meta/update.txt', 'body');
    });

    it('increments generation on data overwrite and resets metageneration', async () => {
      const write = await bucket.writeText('meta/overwrite.txt', 'one', {
        metadata: { contentType: 'text/plain' },
      });
      const metadata = await bucket.setMetadata('meta/overwrite.txt', {
        cacheControl: 'private',
      });
      const overwrite = await bucket.writeText('meta/overwrite.txt', 'two');

      expect(Number(metadata.metageneration)).toBeGreaterThan(1);
      expect(Number(overwrite.metadata.generation)).toBeGreaterThan(
        Number(write.metadata.generation)
      );
      expect(overwrite.metadata.metageneration).toBe('1');
      expect(overwrite.metadata.updatedAt.getTime()).toBeGreaterThanOrEqual(
        overwrite.metadata.createdAt.getTime()
      );
      await expectObjectText(bucket, 'meta/overwrite.txt', 'two');
    });

    it('uses byte length for size rather than string character count', async () => {
      const text = 'pound: £';
      const write = await bucket.writeText('meta/size.txt', text);

      expect(write.metadata.size).toBe(Buffer.byteLength(text));
      expect(write.metadata.size).toBeGreaterThan(text.length);
    });

    it('rejects stale metageneration updates', async () => {
      const write = await bucket.writeText('meta/stale.txt', 'one');
      await bucket.setMetadata('meta/stale.txt', {
        cacheControl: 'private',
      });

      await expectStorageError(
        bucket.setMetadata('meta/stale.txt', {
          cacheControl: 'public',
          precondition: {
            type: 'metageneration-match',
            metageneration: write.metadata.metageneration,
          },
        }),
        'storage/precondition-failed'
      );
    });
  });
}
