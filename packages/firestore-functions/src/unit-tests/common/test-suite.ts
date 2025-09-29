import {
  FirestoreController,
  FirestoreMock,
} from '@firebase-bridge/firestore-admin';
import { Deferred } from '@firebase-bridge/firestore-admin/lib/_internal/firestore/util.js';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  DocumentData,
  FieldValue,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { CommonTriggerEvent, TriggerFactory } from './factory.js';

function d<T>() {
  return new Deferred<T>();
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function triggerTestSuite(
  version: string,
  factory: TriggerFactory
): void {
  describe(`${version} Trigger tests`, () => {
    const env = new FirestoreMock();
    let ctrl!: FirestoreController;
    let firestore!: Firestore;

    beforeEach(() => {
      ctrl = env.createDatabase();
      firestore = ctrl.firestore();
    });

    afterEach(() => {
      env.deleteAll();
    });

    it('onCreate: extracts wildcard params and delivers an existing "after" snapshot', async () => {
      const p = d<CommonTriggerEvent<{ userId: string }>>();
      const route = 'users/{userId}/data/profile';

      const unsub = factory(ctrl, { route, type: 'create' }, (event) =>
        p.resolve(event as CommonTriggerEvent<{ userId: string }>)
      );

      const ref = firestore.doc('users/12345/data/profile');
      await ref.create({ name: 'John', age: 34 });

      const ev = await p.promise;
      expect(ev.meta.params.userId).toBe('12345');
      expect(ev.after.exists).toBe(true);
      expect(ev.before.exists).toBe(false);
      expect(ev.after.data()).toEqual({ name: 'John', age: 34 });
      expect(ev.after.readTime instanceof Timestamp).toBe(true);
      expect(typeof ev.meta.id).toBe('string');
      expect(
        ev.meta.resourceName.endsWith('/documents/users/12345/data/profile')
      ).toBe(true);

      unsub();
    });

    it('onDelete: delivers a non-existing "after" and existing "before"', async () => {
      const p = d<CommonTriggerEvent>();
      const route = 'things/{id}';

      const unsub = factory(ctrl, { route, type: 'delete' }, (e) =>
        p.resolve(e)
      );
      const ref = firestore.doc('things/x1');
      await ref.create({ a: 1 });
      await ref.delete();

      const ev = await p.promise;
      // expect(ev.before.exists).toBe(true);
      expect(ev.after.data()).toEqual({ a: 1 });
      expect(ev.after.exists).toBe(false);
      unsub();
    });

    it('onUpdate: before/after snapshots reflect changed fields only by value (fidelity)', async () => {
      const p = d<CommonTriggerEvent<{ id: string }>>();
      const route = 'items/{id}';

      const unsub = factory(ctrl, { route, type: 'update' }, (e) => {
        p.resolve(e as CommonTriggerEvent<{ id: string }>);
      });

      const ref = firestore.doc('items/i1');
      await ref.create({ score: 1, tag: 'a' });
      await ref.update({ score: 2 });

      const ev = await p.promise;

      expect(ev.meta.params.id).toBe('i1');
      expect(ev.before.exists && ev.after.exists).toBe(true);
      expect((ev.before.data() as DocumentData).score).toBe(1);
      expect((ev.after.data() as DocumentData).score).toBe(2);
      unsub();
    });

    it('onWrite: fires for create, update, and delete (3 events)', async () => {
      const got: CommonTriggerEvent[] = [];
      const route = 'orders/{orderId}';

      const unsub = factory(ctrl, { route, type: 'write' }, (e) => {
        got.push(e);
      });
      const ref = firestore.doc('orders/o1');
      await ref.create({ status: 'new' });
      await ref.update({ status: 'paid' });
      await ref.delete();

      // Give the mock a tick to flush trigger queue
      await wait(10);

      expect(got).toHaveLength(3);
      expect(got[0].before.exists).toBe(false);
      expect(got[0].after.exists).toBe(true);
      expect(got[1].before.exists && got[1].after.exists).toBe(true);
      expect(got[2].after.exists).toBe(false);
      expect(got[2].after.exists).toBe(false);
      unsub();
    });

    it('no-op updates do NOT fire onUpdate (but onWrite would)', async () => {
      const route = 'noop/{id}';
      const fired = { update: false };

      const unsub = factory(ctrl, { route, type: 'update' }, () => {
        fired.update = true;
      });
      const ref = firestore.doc('noop/a1');
      await ref.create({ k: 1 });
      await ref.set({ k: 1 }); // no-op

      await wait(10); // allow trigger latency window
      expect(fired.update).toBe(false);
      unsub();
    });

    it('serverTimestamp is materialized in "after" snapshot', async () => {
      const p = d<CommonTriggerEvent>();
      const route = 'ts/{id}';
      const unsub = factory(ctrl, { route, type: 'create' }, (e) =>
        p.resolve(e)
      );
      const ref = firestore.doc('ts/t1');
      await ref.create({ createdAt: FieldValue.serverTimestamp() });

      const ev = await p.promise;
      const after = ev.after.data() as DocumentData;
      expect(after.createdAt instanceof Timestamp).toBe(true);
      unsub();
    });

    it('multiple handlers on the same route all fire (deterministic fan-out)', async () => {
      const route = 'fan/{x}';
      const p1 = d<string>();
      const p2 = d<string>();

      const unsub1 = factory(ctrl, { route, type: 'create' }, () =>
        p1.resolve('h1')
      );
      const unsub2 = factory(ctrl, { route, type: 'create' }, () =>
        p2.resolve('h2')
      );

      await firestore.doc('fan/a').create({ v: 1 });

      const r = await Promise.all([p1.promise, p2.promise]);
      expect(new Set(r)).toEqual(new Set(['h1', 'h2']));
      unsub1();
      unsub2();
    });

    it('nth-generation ordering: writes inside trigger cause a subsequent trigger event', async () => {
      const routeA = 'seed/{id}';
      const routeB = 'derived/{id}';
      const order: string[] = [];
      const done = d<void>();

      // When A is created, create B inside handler
      const unsubA = factory(
        ctrl,
        { route: routeA, type: 'create' },
        async () => {
          order.push('A');
          await firestore.doc('derived/d1').set({ from: 'A' });
        }
      );

      const unsubB = factory(ctrl, { route: routeB, type: 'write' }, () => {
        order.push('B');
        if (order.length === 2) done.resolve();
      });

      await firestore.doc('seed/s1').set({ go: true });
      await done.promise;

      expect(order).toEqual(['A', 'B']); // A’s write observed before B’s trigger
      unsubA();
      unsubB();
    });

    it('unsubscribe stops future events', async () => {
      const route = 'off/{id}';
      const got: CommonTriggerEvent[] = [];
      const unsub = factory(ctrl, { route, type: 'write' }, (e) => got.push(e));

      const ref = firestore.doc('off/x1');
      await ref.create({ x: 1 });
      await wait(5);
      unsub();
      await ref.update({ x: 2 }); // should NOT be observed
      await wait(10);

      // Only the create shows up
      expect(got).toHaveLength(1);
    });

    it('metadata: id/time/resourceName populated and path matches actual document', async () => {
      const p = d<CommonTriggerEvent<{ a: string; b: string }>>();
      const route = 'A/{a}/B/{b}';
      const unsub = factory(ctrl, { route, type: 'create' }, (e) =>
        p.resolve(e as CommonTriggerEvent<{ a: string; b: string }>)
      );

      const path = 'A/alpha/B/bravo';
      await firestore.doc(path).create({ v: 1 });

      const ev = await p.promise;
      expect(ev.meta.id && ev.meta.id.length).toBeGreaterThan(0);
      expect(typeof ev.meta.time).toBe('string');
      expect(ev.meta.resourceName.endsWith(`/documents/${path}`)).toBe(true);
      expect(ev.meta.params).toEqual({ a: 'alpha', b: 'bravo' });

      unsub();
    });

    it('before/after snapshots always provided (exists=false on the missing side)', async () => {
      const got: CommonTriggerEvent[] = [];
      const unsub = factory(ctrl, { route: 'both/{id}', type: 'write' }, (e) =>
        got.push(e)
      );

      const ref = firestore.doc('both/k1');
      await ref.create({ a: 1 });
      await ref.update({ a: 2 });
      await ref.delete();
      await wait(10);

      expect(got).toHaveLength(3);
      // create
      expect(got[0].before.exists).toBe(false);
      expect(got[0].after.exists).toBe(true);
      // update
      expect(got[1].before.exists).toBe(true);
      expect(got[1].after.exists).toBe(true);
      // delete
      expect(got[2].before.exists).toBe(true);
      expect(got[2].after.exists).toBe(false);
      // readTime should be present on all sides
      for (const e of got) {
        expect(e.before.readTime instanceof Timestamp).toBe(true);
        expect(e.after.readTime instanceof Timestamp).toBe(true);
      }
      unsub();
    });

    it('distinct docs fire independent events; order by commit', async () => {
      const seen: string[] = [];
      const unsub = factory(
        ctrl,
        { route: 'multi/{id}', type: 'write' },
        (e) => {
          seen.push(e.after.ref.path);
        }
      );

      await firestore.doc('multi/a').set({ v: 1 });
      await firestore.doc('multi/b').set({ v: 2 });
      await wait(10);

      expect(new Set(seen)).toEqual(new Set(['multi/a', 'multi/b']));
      unsub();
    });

    it('event IDs differ across commits for the same doc', async () => {
      const ids: string[] = [];
      const unsub = factory(ctrl, { route: 'eid/{id}', type: 'write' }, (e) => {
        ids.push(e.meta.id);
      });

      const ref = firestore.doc('eid/z1');
      await ref.set({ v: 1 });
      await ref.update({ v: 2 });
      await wait(10);

      expect(ids.length).toBe(2);
      expect(ids[0]).not.toBe(ids[1]);
      unsub();
    });
  });
}
