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

    it('lists objects lexicographically with pagination', async () => {
      await bucket.writeText('list/c.txt', 'c');
      await bucket.writeText('list/a.txt', 'a');
      await bucket.writeText('list/b.txt', 'b');

      const page1 = await bucket.list({ prefix: 'list/', pageSize: 2 });
      expect(page1.objects.map((m) => m.path)).toEqual([
        'list/a.txt',
        'list/b.txt',
      ]);
      expect(page1.nextPageToken).toBeDefined();

      const page2 = await bucket.list({
        prefix: 'list/',
        pageSize: 2,
        pageToken: page1.nextPageToken,
      });
      expect(page2.objects.map((m) => m.path)).toEqual(['list/c.txt']);
    });

    it('stores byte copies and returns immutable read snapshots', async () => {
      const input = new Uint8Array([65, 66, 67]);
      await bucket.write('bytes/raw.bin', input);
      input[0] = 90;

      const firstRead = await bucket.read('bytes/raw.bin');
      expect([...firstRead.data]).toEqual([65, 66, 67]);
      firstRead.data[1] = 89;

      const secondRead = await bucket.read('bytes/raw.bin');
      expect([...secondRead.data]).toEqual([65, 66, 67]);
    });

    it('honors explicit text encodings where supported', async () => {
      await bucket.writeText('text/latin1.txt', '£', { encoding: 'latin1' });

      expect(await bucket.readText('text/latin1.txt', { encoding: 'latin1' })).toBe(
        '£'
      );
      expect((await bucket.getMetadata('text/latin1.txt')).size).toBe(1);
    });

    it('delegates object handle operations to the backing bucket', async () => {
      const object = bucket.object('handles/file.txt');

      expect(object.bucketId).toBe(bucket.bucketId);
      expect(object.path).toBe('handles/file.txt');
      await expect(object.exists()).resolves.toBe(false);

      const write = await object.writeText('hello', {
        metadata: { contentType: 'text/plain' },
      });
      await expect(object.exists()).resolves.toBe(true);
      await expect(object.readText()).resolves.toBe('hello');
      await expect(object.getMetadata()).resolves.toMatchObject({
        generation: write.metadata.generation,
        contentType: 'text/plain',
      });

      await object.setMetadata({ cacheControl: 'private' });

      await expect(object.delete()).resolves.toMatchObject({ deleted: true });
      await expect(object.delete({ ignoreMissing: true })).resolves.toMatchObject({
        deleted: false,
      });
    });
  });
}
