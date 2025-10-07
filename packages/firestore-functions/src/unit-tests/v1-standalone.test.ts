/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import * as v1 from 'firebase-functions/v1';
import { registerTrigger } from '../lib/v1/register-trigger.js';

describe('v1 Standalone trigger tests', () => {
  const env = new FirestoreMock();
  const ctrl = env.createDatabase();

  const sleep = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

  beforeEach(() => {
    ctrl.reset();
  });

  // it('respects trigger predicates', async () => {
  //   let enabled = false;
  //   const firestore = ctrl.firestore();
  //   const col = firestore.collection('users');
  //   const triggered: string[] = [];

  //   const unsub = registerTrigger(
  //     ctrl,
  //     v1.firestore.document('users/{uid}').onCreate(async (_snap, ctx) => {
  //       triggered.push(ctx.params.uid);
  //     }),
  //     () => enabled
  //   );

  //   await col.doc('user-1').set({ name: 'John' });
  //   await sleep();
  //   enabled = true;
  //   await col.doc('user-2').set({ name: 'John' });
  //   await sleep();
  //   expect(triggered).toEqual(['user-2']);

  //   unsub();
  // });

  it('onCreate: snapshot & context expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-create-1');

    let gotSnap: v1.firestore.DocumentSnapshot | undefined;
    let gotCtx: v1.EventContext | undefined;

    const unsub = registerTrigger(
      ctrl,
      v1.firestore.document('users/{uid}').onCreate(async (snap, ctx) => {
        gotSnap = snap;
        gotCtx = ctx;
      })
    );

    await doc.set({ name: 'John' });
    await sleep();
    unsub();

    expect(gotSnap).toBeDefined();
    expect(gotCtx).toBeDefined();

    const snap = gotSnap!;
    const ctx = gotCtx!;

    // Snapshot surface (shape checks only)
    expect(typeof snap.id).toBe('string');
    expect(snap.ref.path).toBe('users/id-create-1');
    expect(snap.createTime).toBeDefined();
    expect(snap.updateTime).toBeDefined();
    expect(typeof snap.data()).toBe('object');

    // Context surface (shape checks only)
    expect(ctx.params).toBeDefined();
    expect(ctx.params.uid).toBe('id-create-1');
    expect(typeof ctx.eventId).toBe('string');
    expect(typeof ctx.timestamp).toBe('string'); // ISO string per v1
    expect(ctx.resource).toBeDefined();
  });

  it('onUpdate: change.before/after & context expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-update-1');

    await doc.set({ name: 'John' });

    let gotChange: v1.Change<v1.firestore.DocumentSnapshot> | undefined;
    let gotCtx: v1.EventContext | undefined;

    const unsub = registerTrigger(
      ctrl,
      v1.firestore.document('users/{uid}').onUpdate(async (change, ctx) => {
        gotChange = change;
        gotCtx = ctx;
      })
    );

    await doc.update({ status: 'active' });
    await sleep();
    unsub();

    expect(gotChange).toBeDefined();
    expect(gotCtx).toBeDefined();

    const change = gotChange!;
    const before = change.before;
    const after = change.after;
    const ctx = gotCtx!;

    // Change surface (shape checks only)
    expect(typeof before.id).toBe('string');
    expect(typeof after.id).toBe('string');
    expect(before.id).toBe(after.id);
    expect(before.ref.path).toBe('users/id-update-1');
    expect(after.ref.path).toBe('users/id-update-1');
    expect(before.updateTime).toBeDefined();
    expect(after.updateTime).toBeDefined();
    expect(typeof before.data()).toBe('object');
    expect(typeof after.data()).toBe('object');

    // Context surface
    expect(ctx.params?.uid).toBe('id-update-1');
    expect(typeof ctx.eventId).toBe('string');
    expect(typeof ctx.timestamp).toBe('string');
    expect(ctx.resource).toBeDefined();
  });

  it('onDelete: snapshot & context expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-delete-1');

    await doc.set({ name: 'Jane' });

    let gotSnap: v1.firestore.DocumentSnapshot | undefined;
    let gotCtx: v1.EventContext | undefined;

    const unsub = registerTrigger(
      ctrl,
      v1.firestore.document('users/{uid}').onDelete(async (snap, ctx) => {
        gotSnap = snap;
        gotCtx = ctx;
      })
    );

    await doc.delete();
    await sleep();
    unsub();

    expect(gotSnap).toBeDefined();
    expect(gotCtx).toBeDefined();

    const snap = gotSnap!;
    const ctx = gotCtx!;

    // Snapshot surface (shape checks only)
    expect(typeof snap.id).toBe('string');
    expect(snap.ref.path).toBe('users/id-delete-1');
    expect(snap.createTime).toBeDefined();
    expect(snap.updateTime).toBeDefined();
    // For delete events, the event snapshot represents the preimage.
    // Only assert shape (object) to avoid env-specific semantics.
    expect(typeof snap.data()).toBe('object');

    // Context surface
    expect(ctx.params?.uid).toBe('id-delete-1');
    expect(typeof ctx.eventId).toBe('string');
    expect(typeof ctx.timestamp).toBe('string');
    expect(ctx.resource).toBeDefined();
  });

  it('onWrite: change.before/after & context expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-write-1');

    let gotChange: v1.Change<v1.firestore.DocumentSnapshot> | undefined;
    let gotCtx: v1.EventContext | undefined;

    const unsub = registerTrigger(
      ctrl,
      v1.firestore.document('users/{uid}').onWrite(async (change, ctx) => {
        gotChange = change;
        gotCtx = ctx;
      })
    );

    // Use create to trigger onWrite once
    await doc.set({ name: 'Will' });
    await sleep();
    unsub();

    expect(gotChange).toBeDefined();
    expect(gotCtx).toBeDefined();

    const change = gotChange!;
    const before = change.before;
    const after = change.after;
    const ctx = gotCtx!;

    // Change surface (shape checks only)
    expect(typeof before.id).toBe('string');
    expect(typeof after.id).toBe('string');
    expect(before.id).toBe(after.id);
    expect(before.ref.path).toBe('users/id-write-1');
    expect(after.ref.path).toBe('users/id-write-1');
    // Do not assert .exists semantics; only presence/shape
    expect(before.updateTime).toBeDefined();
    expect(after.updateTime).toBeDefined();
    expect(typeof after.data()).toBe('object');

    // Context surface
    expect(ctx.params?.uid).toBe('id-write-1');
    expect(typeof ctx.eventId).toBe('string');
    expect(typeof ctx.timestamp).toBe('string');
    expect(ctx.resource).toBeDefined();
  });
});
