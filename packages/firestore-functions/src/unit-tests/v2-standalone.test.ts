/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import * as v2 from 'firebase-functions/v2';
import { registerTrigger } from '../lib/v2/register-trigger.js';

interface ParamType {
  uid: string;
}

type QueryEventType = v2.firestore.FirestoreEvent<
  v2.firestore.QueryDocumentSnapshot | undefined,
  ParamType
>;

type ChangeEventType = v2.firestore.FirestoreEvent<
  v2.Change<v2.firestore.QueryDocumentSnapshot> | undefined,
  ParamType
>;

type DocumentChangeEventType = v2.firestore.FirestoreEvent<
  v2.Change<v2.firestore.DocumentSnapshot> | undefined,
  ParamType
>;

describe('v2 Standalone trigger tests', () => {
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
  //     v2.firestore.onDocumentCreated('users/{uid}', async (event) => {
  //       triggered.push(event.params.uid);
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

  it('onDocumentCreated: snapshot & event expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-create-1');

    let gotEvent: QueryEventType | undefined;

    const unsub = registerTrigger(
      ctrl,
      v2.firestore.onDocumentCreated('users/{uid}', async (event) => {
        gotEvent = event;
      })
    );

    await doc.set({ name: 'John' });
    await sleep();
    unsub();

    expect(gotEvent).toBeDefined();

    const ev = gotEvent!;
    const snap = ev.data!;

    // Snapshot surface (shape checks only)
    expect(typeof snap.id).toBe('string');
    expect(snap.ref.path).toBe('users/id-create-1');
    expect(snap.createTime).toBeDefined();
    expect(snap.updateTime).toBeDefined();
    expect(typeof snap.data()).toBe('object');

    // Event (context) surface
    expect(ev.params?.uid).toBe('id-create-1');
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.time).toBe('string'); // ISO string per v2
    expect(typeof ev.subject).toBe('string'); // resource name
  });

  it('onDocumentUpdated: change.before/after & event expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-update-1');

    await doc.set({ name: 'John' });

    let gotEvent: ChangeEventType | undefined;

    const unsub = registerTrigger(
      ctrl,
      v2.firestore.onDocumentUpdated('users/{uid}', async (event) => {
        gotEvent = event;
      })
    );

    await doc.update({ status: 'active' });
    await sleep();
    unsub();

    expect(gotEvent).toBeDefined();

    const ev = gotEvent!;
    const change = ev.data;
    const before = change!.before;
    const after = change!.after;

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

    // Event (context) surface
    expect(ev.params?.uid).toBe('id-update-1');
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.time).toBe('string');
    expect(typeof ev.subject).toBe('string');
  });

  it('onDocumentDeleted: snapshot & event expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-delete-1');

    await doc.set({ name: 'Jane' });

    let gotEvent: QueryEventType | undefined;

    const unsub = registerTrigger(
      ctrl,
      v2.firestore.onDocumentDeleted('users/{uid}', async (event) => {
        gotEvent = event;
      })
    );

    await doc.delete();
    await sleep();
    unsub();

    expect(gotEvent).toBeDefined();

    const ev = gotEvent!;
    const snap = ev.data!;

    // Snapshot surface (shape checks only)
    expect(typeof snap.id).toBe('string');
    expect(snap.ref.path).toBe('users/id-delete-1');
    expect(snap.createTime).toBeDefined();
    expect(snap.updateTime).toBeDefined();
    // Preimage at delete; assert shape only
    expect(typeof snap.data()).toBe('object');

    // Event (context) surface
    expect(ev.params?.uid).toBe('id-delete-1');
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.time).toBe('string');
    expect(typeof ev.subject).toBe('string');
  });

  it('onDocumentWritten: change.before/after & event expose expected properties', async () => {
    const firestore = ctrl.firestore();
    const doc = firestore.doc('users/id-write-1');

    let gotEvent: DocumentChangeEventType | undefined;

    const unsub = registerTrigger(
      ctrl,
      v2.firestore.onDocumentWritten('users/{uid}', async (event) => {
        gotEvent = event;
      })
    );

    // Use create to trigger once
    await doc.set({ name: 'Will' });
    await sleep();
    unsub();

    expect(gotEvent).toBeDefined();

    const ev = gotEvent!;
    const change = ev.data!;
    const before = change.before;
    const after = change.after;

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

    // Event (context) surface
    expect(ev.params?.uid).toBe('id-write-1');
    expect(typeof ev.id).toBe('string');
    expect(typeof ev.time).toBe('string');
    expect(typeof ev.subject).toBe('string');
  });
});
