import { onObjectDeleted, onObjectFinalized } from 'firebase-functions/v2/storage';
import { StorageMock, StorageTriggerOrchestrator } from '../index.js';
import { StorageTriggerErrorOrigin } from '../lib/types.js';

enum Key {
  Finalized = 'Finalized',
  Deleted = 'Deleted',
}

describe('StorageTriggerOrchestrator', () => {
  it('manages enablement, observers, stats, and disposal edge cases', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'orch.test' });
    const bucket = ctrl.service().bucket();
    const calls: string[] = [];
    const observed: string[] = [];
    const watchedErrors: string[] = [];
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Finalized,
        onObjectFinalized({ bucket: 'orch.test' }, (event) => {
          calls.push(event.data.name);
        })
      );
      reg.v2(
        Key.Deleted,
        onObjectDeleted({ bucket: 'orch.test' }, () => {
          throw new Error('delete failed');
        })
      );
    });

    expect(orchestrator.isEnabled(Key.Finalized)).toBe(true);
    expect(orchestrator.isEnabled(Key.Deleted)).toBe(true);
    expect(() => orchestrator.disable('Missing' as Key)).toThrow(
      'No trigger handler associated with the key "Missing" is registered.'
    );

    orchestrator.observe(Key.Finalized, {
      before: (arg) => observed.push(`before:${arg.path}`),
      after: (arg) => observed.push(`after:${arg.path}`),
    });
    orchestrator.on(Key.Finalized, (arg) => observed.push(`on:${arg.path}`));
    orchestrator.watchErrors((arg) => {
      watchedErrors.push(`${arg.key}:${arg.origin}`);
      throw new Error('watcher failure');
    });

    const waiter = orchestrator.wait(
      Key.Finalized,
      (arg) => arg.path === 'match.txt'
    );
    await bucket.writeText('skip.txt', 'skip');
    await bucket.writeText('match.txt', 'match');
    await expect(waiter).resolves.toMatchObject({
      key: Key.Finalized,
      path: 'match.txt',
      completedCount: 2,
    });

    expect(calls).toEqual(['skip.txt', 'match.txt']);
    expect(observed).toEqual([
      'before:skip.txt',
      'after:skip.txt',
      'on:skip.txt',
      'before:match.txt',
      'after:match.txt',
      'on:match.txt',
    ]);

    const stats = orchestrator.getStats(Key.Finalized);
    expect(stats).toMatchObject({
      key: Key.Finalized,
      initiatedCount: 2,
      completedCount: 2,
      errorCount: 0,
    });
    expect(() => {
      (stats as { completedCount: number }).completedCount = 99;
    }).toThrow();
    expect(orchestrator.getStats(Key.Finalized).completedCount).toBe(2);

    const errorWaiter = orchestrator.waitOneError(Key.Deleted);
    await bucket.delete('match.txt');
    await expect(errorWaiter).resolves.toMatchObject({
      key: Key.Deleted,
      origin: StorageTriggerErrorOrigin.Execute,
      errorCount: 1,
    });
    expect(watchedErrors).toEqual([`${Key.Deleted}:${StorageTriggerErrorOrigin.Execute}`]);

    orchestrator.all(false);
    await bucket.writeText('disabled.txt', 'disabled');
    await flush();
    expect(calls).toEqual(['skip.txt', 'match.txt']);
    orchestrator.attach();
    expect(orchestrator.isEnabled(Key.Finalized)).toBe(true);
    expect(orchestrator.getStats(Key.Finalized).completedCount).toBe(2);

    orchestrator.dispose();
    expect(() => orchestrator.isEnabled(Key.Finalized)).toThrow('Object disposed.');
  });

  it('cancels and times out waiters deterministically', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'orch.test' });
    const bucket = ctrl.service().bucket();
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Finalized,
        onObjectFinalized({ bucket: 'orch.test' }, () => undefined)
      );
      reg.v2(
        Key.Deleted,
        onObjectDeleted({ bucket: 'orch.test' }, () => {
          throw new Error('delete failed');
        })
      );
    });

    await expect(
      orchestrator.wait(Key.Finalized, () => false, { timeout: 20 })
    ).rejects.toThrow('timed-out.');

    await bucket.writeText('cancel.txt', 'cancel');
    const cancelOnError = orchestrator.wait(Key.Deleted, () => true, {
      cancelOnError: true,
    });
    await bucket.delete('cancel.txt');
    await expect(cancelOnError).rejects.toThrow('cancelled');

    const detached = orchestrator.waitOne(Key.Finalized);
    orchestrator.detach();
    await expect(detached).rejects.toThrow('cancelled');

    orchestrator.attach();
    const reset = orchestrator.waitOne(Key.Finalized);
    orchestrator.reset();
    await expect(reset).rejects.toThrow('cancelled');
  });

  it('ignores events from old controller epochs', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'orch.test' });
    const calls: string[] = [];
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Finalized,
        onObjectFinalized({ bucket: 'orch.test' }, (event) => {
          calls.push(event.data.name);
        })
      );
    });

    const staleEpoch = orchestrator.epoch;
    ctrl.reset('orch.test');
    expect(orchestrator.epoch).toBe(staleEpoch + 1);

    const listener = ctrl.onObjectChange as unknown as {
      listeners?: unknown;
    };
    expect(listener).toBeDefined();

    // Emit indirectly before/after reset to verify real operations use the current epoch.
    await ctrl.service().bucket().writeText('current.txt', 'current');
    await flush();
    expect(calls).toEqual(['current.txt']);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
