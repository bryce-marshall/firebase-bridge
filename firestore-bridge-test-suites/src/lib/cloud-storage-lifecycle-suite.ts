import type { CloudStorageBucket } from '@firebase-bridge/cloud-storage';
import { CloudStorageBridgeTestContext } from './cloud-storage-test-context.js';

export function cloudStorageLifecycleSuite(
  context: CloudStorageBridgeTestContext
) {
  describe('Cloud Storage Object Lifecycle', () => {
    let bucket!: CloudStorageBucket;

    beforeAll(async () => {
      bucket = await context.init('lifecycle.test');
    });

    afterAll(async () => {
      await context.tearDown();
    });

    it('writes, reads, updates metadata, and deletes text objects', async () => {
      const write = await bucket.writeText('imports/a.csv', 'date,amount\n', {
        metadata: {
          contentType: 'text/csv',
          customMetadata: { importId: 'a' },
        },
      });

      expect(write.metadata.path).toBe('imports/a.csv');
      expect(write.metadata.size).toBe(Buffer.byteLength('date,amount\n'));
      expect(await bucket.exists('imports/a.csv')).toBe(true);
      expect(await bucket.readText('imports/a.csv')).toBe('date,amount\n');

      const metadata = await bucket.setMetadata('imports/a.csv', {
        cacheControl: 'private',
      });
      expect(metadata.generation).toBe(write.metadata.generation);
      expect(Number(metadata.metageneration)).toBeGreaterThan(
        Number(write.metadata.metageneration)
      );
      expect(metadata.customMetadata.importId).toBe('a');

      const deleted = await bucket.delete('imports/a.csv');
      expect(deleted.deleted).toBe(true);
      expect(await bucket.exists('imports/a.csv')).toBe(false);
    });

    it('enforces create and generation preconditions', async () => {
      const first = await bucket.writeText('preconditions/file.txt', 'one', {
        precondition: { type: 'does-not-exist' },
      });

      await expect(
        bucket.writeText('preconditions/file.txt', 'two', {
          precondition: { type: 'does-not-exist' },
        })
      ).rejects.toMatchObject({ code: 'storage/precondition-failed' });

      await expect(
        bucket.writeText('preconditions/file.txt', 'two', {
          precondition: {
            type: 'generation-match',
            generation: first.metadata.generation,
          },
        })
      ).resolves.toBeDefined();
    });

    it('lists objects lexicographically with deterministic page tokens', async () => {
      await bucket.writeText('list/c.txt', 'c');
      await bucket.writeText('list/a.txt', 'a');
      await bucket.writeText('list/b.txt', 'b');

      const page1 = await bucket.list({ prefix: 'list/', pageSize: 2 });
      expect(page1.objects.map((m) => m.path)).toEqual([
        'list/a.txt',
        'list/b.txt',
      ]);
      expect(page1.nextPageToken).toBe('2');

      const page2 = await bucket.list({
        prefix: 'list/',
        pageSize: 2,
        pageToken: page1.nextPageToken,
      });
      expect(page2.objects.map((m) => m.path)).toEqual(['list/c.txt']);
      expect(page2.nextPageToken).toBeUndefined();
    });
  });
}
