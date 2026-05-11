import type { CloudStorageBucket } from '@firebase-bridge/cloud-storage';
import { CloudStorageBridgeTestContext } from './cloud-storage-test-context.js';
import {
  expectNoObject,
  expectObjectMissing,
  expectPreconditionFailed,
  expectStorageError,
} from './helpers.js';

export function cloudStorageErrorModelSuite(
  context: CloudStorageBridgeTestContext
) {
  describe('Cloud Storage Error Model', () => {
    let bucket!: CloudStorageBucket;

    beforeEach(async () => {
      bucket = await context.init('errors.test');
    });

    afterEach(async () => {
      await context.tearDown();
    });

    it('maps invalid paths to stable storage errors', async () => {
      await expectStorageError(bucket.exists(''), 'storage/invalid-path');
      await expectStorageError(bucket.read('/leading-slash.txt'), 'storage/invalid-path');
      await expectStorageError(
        bucket.writeText('', 'nope'),
        'storage/invalid-path'
      );
    });

    it('maps missing object operations to object-not-found', async () => {
      await expectObjectMissing(bucket.read('missing.txt'));
      await expectObjectMissing(bucket.readText('missing.txt'));
      await expectObjectMissing(bucket.getMetadata('missing.txt'));
      await expectObjectMissing(bucket.setMetadata('missing.txt', {
        contentType: 'text/plain',
      }));
      await expectObjectMissing(bucket.delete('missing.txt'));
      await expectObjectMissing(
        bucket.createSignedReadUrl('missing.txt', {
          expiresAt: new Date('2026-01-02T00:00:00.000Z'),
        })
      );
    });

    it('does not apply side effects after precondition failures', async () => {
      const first = await bucket.writeText('conflict.txt', 'one');

      await expectPreconditionFailed(
        bucket.writeText('conflict.txt', 'two', {
          precondition: { type: 'does-not-exist' },
        })
      );
      await expect(bucket.readText('conflict.txt')).resolves.toBe('one');

      await expectPreconditionFailed(
        bucket.delete('conflict.txt', {
          precondition: {
            type: 'generation-match',
            generation: `${Number(first.metadata.generation) + 100}`,
          },
        })
      );
      await expect(bucket.readText('conflict.txt')).resolves.toBe('one');
    });

    it('keeps failed missing-object operations side-effect free', async () => {
      await expectObjectMissing(bucket.delete('still-missing.txt'));
      await expectNoObject(bucket, 'still-missing.txt');
    });
  });
}
