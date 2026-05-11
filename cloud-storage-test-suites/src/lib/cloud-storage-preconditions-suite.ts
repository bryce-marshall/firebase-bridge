import type {
  CloudStorageBucket,
  CloudStorageObjectMetadata,
} from '@firebase-bridge/cloud-storage';
import { CloudStorageBridgeTestContext } from './cloud-storage-test-context.js';
import {
  expectObjectText,
  expectPreconditionFailed,
} from './helpers.js';

export function cloudStoragePreconditionsSuite(
  context: CloudStorageBridgeTestContext
) {
  describe('Cloud Storage Preconditions', () => {
    let bucket!: CloudStorageBucket;

    beforeEach(async () => {
      bucket = await context.init('preconditions.test');
    });

    afterEach(async () => {
      await context.tearDown();
    });

    it('allows omitted and explicit none preconditions to overwrite', async () => {
      await bucket.writeText('overwrite.txt', 'one');
      await bucket.writeText('overwrite.txt', 'two');
      await expectObjectText(bucket, 'overwrite.txt', 'two');

      await bucket.writeText('overwrite.txt', 'three', {
        precondition: { type: 'none' },
      });
      await expectObjectText(bucket, 'overwrite.txt', 'three');
    });

    it('enforces does-not-exist on writes', async () => {
      await bucket.writeText('create.txt', 'one', {
        precondition: { type: 'does-not-exist' },
      });
      await expectObjectText(bucket, 'create.txt', 'one');

      await expectPreconditionFailed(
        bucket.writeText('create.txt', 'two', {
          precondition: { type: 'does-not-exist' },
        })
      );
      await expectObjectText(bucket, 'create.txt', 'one');
    });

    it('enforces generation-match on writes', async () => {
      const first = await bucket.writeText('generation.txt', 'one');

      const second = await bucket.writeText('generation.txt', 'two', {
        precondition: {
          type: 'generation-match',
          generation: first.metadata.generation,
        },
      });
      await expectObjectText(bucket, 'generation.txt', 'two');

      await expectPreconditionFailed(
        bucket.writeText('generation.txt', 'stale', {
          precondition: {
            type: 'generation-match',
            generation: first.metadata.generation,
          },
        })
      );
      await expectPreconditionFailed(
        bucket.writeText('missing-generation.txt', 'missing', {
          precondition: {
            type: 'generation-match',
            generation: second.metadata.generation,
          },
        })
      );
    });

    it('enforces metageneration-match on metadata updates', async () => {
      const first = await bucket.writeText('metageneration.txt', 'one');
      const updated = await bucket.setMetadata('metageneration.txt', {
        cacheControl: 'private',
        precondition: {
          type: 'metageneration-match',
          metageneration: first.metadata.metageneration,
        },
      });

      expect(Number(updated.metageneration)).toBeGreaterThan(
        Number(first.metadata.metageneration)
      );

      await expectPreconditionFailed(
        bucket.setMetadata('metageneration.txt', {
          cacheControl: 'public',
          precondition: {
            type: 'metageneration-match',
            metageneration: first.metadata.metageneration,
          },
        })
      );
      await expectPreconditionFailed(
        bucket.setMetadata('missing-metageneration.txt', {
          cacheControl: 'public',
          precondition: {
            type: 'metageneration-match',
            metageneration: first.metadata.metageneration,
          },
        })
      );
    });

    it('requires both generation and metageneration when requested', async () => {
      const first = await bucket.writeText('both.txt', 'one');
      const metadata = await bucket.setMetadata('both.txt', {
        cacheControl: 'private',
      });

      await bucket.writeText('both.txt', 'two', {
        precondition: both(metadata),
      });

      const current = await bucket.getMetadata('both.txt');
      await expectPreconditionFailed(
        bucket.writeText('both.txt', 'stale-meta', {
          precondition: {
            type: 'generation-and-metageneration-match',
            generation: current.generation,
            metageneration: metadata.metageneration,
          },
        })
      );
      await expectPreconditionFailed(
        bucket.writeText('both.txt', 'stale-generation', {
          precondition: {
            type: 'generation-and-metageneration-match',
            generation: first.metadata.generation,
            metageneration: current.metageneration,
          },
        })
      );
    });

    it('enforces generation-match on deletes and preserves objects on failure', async () => {
      const first = await bucket.writeText('delete.txt', 'one');
      await expectPreconditionFailed(
        bucket.delete('delete.txt', {
          precondition: {
            type: 'generation-match',
            generation: `${Number(first.metadata.generation) + 100}`,
          },
        })
      );
      await expectObjectText(bucket, 'delete.txt', 'one');

      const deleted = await bucket.delete('delete.txt', {
        precondition: {
          type: 'generation-match',
          generation: first.metadata.generation,
        },
      });
      expect(deleted.deleted).toBe(true);
      await expect(bucket.exists('delete.txt')).resolves.toBe(false);
    });
  });
}

function both(metadata: CloudStorageObjectMetadata) {
  return {
    type: 'generation-and-metageneration-match' as const,
    generation: metadata.generation,
    metageneration: metadata.metageneration,
  };
}
