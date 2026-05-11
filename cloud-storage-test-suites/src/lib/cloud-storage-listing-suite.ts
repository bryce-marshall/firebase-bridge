import type { CloudStorageBucket } from '@firebase-bridge/cloud-storage';
import { CloudStorageBridgeTestContext } from './cloud-storage-test-context.js';

export function cloudStorageListingSuite(
  context: CloudStorageBridgeTestContext
) {
  describe('Cloud Storage Listing', () => {
    let bucket!: CloudStorageBucket;

    beforeEach(async () => {
      bucket = await context.init('listing.test');
    });

    afterEach(async () => {
      await context.tearDown();
    });

    it('returns no objects for an empty bucket', async () => {
      await expect(bucket.list()).resolves.toMatchObject({ objects: [] });
    });

    it('sorts paths lexicographically and filters by prefix', async () => {
      await bucket.writeText('z.txt', 'z');
      await bucket.writeText('a/two.txt', 'two');
      await bucket.writeText('a/one.txt', 'one');

      const all = await bucket.list();
      expect(all.objects.map((object) => object.path)).toEqual([
        'a/one.txt',
        'a/two.txt',
        'z.txt',
      ]);

      const prefixed = await bucket.list({ prefix: 'a/' });
      expect(prefixed.objects.map((object) => object.path)).toEqual([
        'a/one.txt',
        'a/two.txt',
      ]);

      await expect(bucket.list({ prefix: 'missing/' })).resolves.toMatchObject({
        objects: [],
      });
    });

    it('paginates without assuming a provider-specific token shape', async () => {
      await bucket.writeText('page/a.txt', 'a');
      await bucket.writeText('page/b.txt', 'b');
      await bucket.writeText('page/c.txt', 'c');

      const first = await bucket.list({ prefix: 'page/', pageSize: 2 });
      expect(first.objects.map((object) => object.path)).toEqual([
        'page/a.txt',
        'page/b.txt',
      ]);
      expect(first.nextPageToken).toBeDefined();

      const second = await bucket.list({
        prefix: 'page/',
        pageSize: 2,
        pageToken: first.nextPageToken,
      });
      expect(second.objects.map((object) => object.path)).toEqual(['page/c.txt']);
      expect(second.nextPageToken).toBeUndefined();
    });

    it('includes current metadata and excludes deleted objects', async () => {
      await bucket.writeText('current/a.txt', 'a', {
        metadata: { contentType: 'text/plain' },
      });
      await bucket.writeText('current/b.txt', 'b');
      const updated = await bucket.setMetadata('current/a.txt', {
        cacheControl: 'private',
      });
      await bucket.delete('current/b.txt');

      const list = await bucket.list({ prefix: 'current/' });
      expect(list.objects.map((object) => object.path)).toEqual(['current/a.txt']);
      expect(list.objects[0]).toMatchObject({
        generation: updated.generation,
        metageneration: updated.metageneration,
        cacheControl: 'private',
      });
    });
  });
}
