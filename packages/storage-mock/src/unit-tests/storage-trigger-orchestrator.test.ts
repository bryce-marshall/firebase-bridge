import { onObjectDeleted, onObjectFinalized } from 'firebase-functions/v2/storage';
import { StorageMock, StorageTriggerOrchestrator } from '../index.js';
import {
  StorageChangeRecord,
  StorageTriggerErrorOrigin,
} from '../lib/types.js';

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
    expect(() => orchestrator.observe('Missing' as Key, {})).toThrow(
      'No trigger handler associated with the key "Missing" is registered.'
    );
    expect(() => orchestrator.waitOne('Missing' as Key)).toThrow(
      'No trigger handler associated with the key "Missing" is registered.'
    );

    orchestrator.observe(Key.Finalized, {
      before: (arg) => observed.push(`before:${arg.path}`),
      after: (arg) => observed.push(`after:${arg.path}`),
    });
    orchestrator.on(Key.Finalized, (arg) => observed.push(`on:${arg.path}`));
    orchestrator.observeAll({
      after: (arg) => observed.push(`all:${arg.key}:${arg.path}`),
    });
    orchestrator.onAll((arg) => observed.push(`onAll:${arg.key}:${arg.path}`));
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
      'all:Finalized:skip.txt',
      'onAll:Finalized:skip.txt',
      'before:match.txt',
      'after:match.txt',
      'on:match.txt',
      'all:Finalized:match.txt',
      'onAll:Finalized:match.txt',
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
    orchestrator.all(true);
    await bucket.writeText('reenabled.txt', 'reenabled');
    await flush();
    expect(calls).toEqual(['skip.txt', 'match.txt', 'reenabled.txt']);

    orchestrator.all(false);
    orchestrator.attach();
    expect(orchestrator.isEnabled(Key.Finalized)).toBe(true);
    expect(orchestrator.getStats(Key.Finalized).completedCount).toBe(3);

    orchestrator.suspended = true;
    await bucket.writeText('suspended.txt', 'suspended');
    await flush();
    expect(calls).toEqual(['skip.txt', 'match.txt', 'reenabled.txt']);
    orchestrator.suspended = false;
    await bucket.writeText('resumed.txt', 'resumed');
    await flush();
    expect(calls).toEqual([
      'skip.txt',
      'match.txt',
      'reenabled.txt',
      'resumed.txt',
    ]);

    orchestrator.dispose();
    expect(() => orchestrator.isEnabled(Key.Finalized)).toThrow('Object disposed.');
    expect(() => orchestrator.all(true)).toThrow('Object disposed.');
    expect(() => orchestrator.enable(Key.Finalized)).toThrow('Object disposed.');
    expect(() => orchestrator.disable(Key.Finalized)).toThrow('Object disposed.');
    expect(() => orchestrator.getStats(Key.Finalized)).toThrow('Object disposed.');
    expect(() => orchestrator.observe(Key.Finalized, {})).toThrow('Object disposed.');
    expect(() => orchestrator.watchErrors(() => undefined)).toThrow(
      'Object disposed.'
    );
    expect(() => orchestrator.waitOne(Key.Finalized)).toThrow('Object disposed.');
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

  it('treats detach, reset, and dispose as no-ops after disposal', () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'orch.test' });
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Finalized,
        onObjectFinalized({ bucket: 'orch.test' }, () => undefined)
      );
    });

    orchestrator.dispose();

    expect(() => orchestrator.detach()).not.toThrow();
    expect(() => orchestrator.reset()).not.toThrow();
    expect(() => orchestrator.dispose()).not.toThrow();
    expect(orchestrator.isDisposed).toBe(true);
  });

  it('reports observer failures through watchErrors and keeps executing handlers', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'orch.test' });
    const bucket = ctrl.service().bucket();
    const calls: string[] = [];
    const watchedErrors: unknown[] = [];
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Finalized,
        onObjectFinalized({ bucket: 'orch.test' }, (event) => {
          calls.push(event.data.name);
        })
      );
    });
    orchestrator.watchErrors((arg) => watchedErrors.push(arg));
    orchestrator.observe(Key.Finalized, {
      before() {
        throw new Error('before failed');
      },
      after() {
        throw new Error('after failed');
      },
    });

    await bucket.writeText('observer.txt', 'observer');
    await flush();

    expect(calls).toEqual(['observer.txt']);
    expect(watchedErrors).toEqual([
      expect.objectContaining({
        key: Key.Finalized,
        origin: StorageTriggerErrorOrigin.OnBefore,
        path: 'observer.txt',
      }),
      expect.objectContaining({
        key: Key.Finalized,
        origin: StorageTriggerErrorOrigin.OnAfter,
        path: 'observer.txt',
      }),
    ]);
  });

  it('waits for matching error predicates', async () => {
    const ctrl = new StorageMock().createStorage({ defaultBucket: 'orch.test' });
    const bucket = ctrl.service().bucket();
    const orchestrator = new StorageTriggerOrchestrator<Key>(ctrl, (reg) => {
      reg.v2(
        Key.Deleted,
        onObjectDeleted({ bucket: 'orch.test' }, () => {
          throw new Error('delete failed');
        })
      );
    });

    await bucket.writeText('skip-error.txt', 'skip');
    await bucket.writeText('match-error.txt', 'match');
    const waiter = orchestrator.waitError(
      Key.Deleted,
      (arg) => arg.path === 'match-error.txt'
    );

    await bucket.delete('skip-error.txt');
    await bucket.delete('match-error.txt');

    await expect(waiter).resolves.toMatchObject({
      key: Key.Deleted,
      path: 'match-error.txt',
      errorCount: 2,
    });
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

    let captured: StorageChangeRecord | undefined;
    const unsubscribeCapture = ctrl.onObjectChange((record) => {
      captured = record;
    });
    await ctrl.service().bucket().writeText('stale.txt', 'stale');
    await flush();
    expect(calls).toEqual(['stale.txt']);
    unsubscribeCapture();

    const staleEvent = captured;
    if (!staleEvent) throw new Error('Expected captured storage event.');
    calls.length = 0;
    const staleEpoch = orchestrator.epoch;
    ctrl.reset('orch.test');
    expect(orchestrator.epoch).toBe(staleEpoch + 1);

    const internal = ctrl as unknown as {
      changeListeners: { next(record: StorageChangeRecord): void };
    };
    internal.changeListeners.next(staleEvent);
    await flush();
    expect(calls).toEqual([]);

    await ctrl.service().bucket().writeText('current.txt', 'current');
    await flush();
    expect(calls).toEqual(['current.txt']);
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
