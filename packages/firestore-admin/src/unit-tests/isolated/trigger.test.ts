import { FirestoreMock } from '../..';
import { Deferred } from '../../lib/_internal/firestore/util';

type TriggerArg = {
  params: Record<string, string>;
  doc: { exists: boolean };
};

describe('DataAccessor trigger (low-level in-memory)', () => {
  let env!: FirestoreMock;

  beforeEach(() => {
    env = new FirestoreMock();
  });

  afterEach(() => {
    env.resetAll();
  });

  function deferUntil(count: number) {
    const d = new Deferred<void>();
    let seen = 0;
    return {
      inc() {
        seen += 1;
        if (seen >= count) d.resolve();
      },
      promise: d.promise,
    };
  }

  function sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  it('fires on create and delete for a single fixed path', async () => {
    const calls: { exists: boolean; userId: string }[] = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'users/{userId}/data/profile',
      callback: (arg: TriggerArg) => {
        calls.push({ exists: arg.doc.exists, userId: arg.params.userId });
        p.inc();
      },
    });

    const path = 'users/12345/data/profile'; // 4 segments => document path
    db.database.setDocument(path, { name: 'John', age: 35 }); // create
    db.database.deleteDocument(path); // delete

    await p.promise;

    expect(calls).toEqual([
      { exists: true, userId: '12345' },
      { exists: false, userId: '12345' },
    ]);
  });

  it('fires on update (exists=true both times)', async () => {
    const calls: { exists: boolean }[] = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'users/{userId}/data/profile',
      callback: (arg: TriggerArg) => {
        calls.push({ exists: arg.doc.exists });
        p.inc();
      },
    });

    const path = 'users/u1/data/profile';
    db.database.setDocument(path, { name: 'Alice', age: 20 }); // create
    db.database.setDocument(path, { name: 'Alice', age: 21 }); // update

    await p.promise;
    expect(calls).toEqual([{ exists: true }, { exists: true }]);
  });

  it('extracts multiple params from a nested route pattern', async () => {
    const seen: Array<{ userId: string; postId: string; exists: boolean }> = [];
    const p = deferUntil(3);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'users/{userId}/posts/{postId}',
      callback: (arg: TriggerArg) => {
        const { userId, postId } = arg.params as {
          userId: string;
          postId: string;
        };
        seen.push({ userId, postId, exists: arg.doc.exists });
        p.inc();
      },
    });

    const p1 = 'users/uA/posts/p1';
    const p2 = 'users/uA/posts/p2';

    db.database.setDocument(p1, { title: 'Hello' }); // create
    db.database.setDocument(p2, { title: 'World' }); // create
    db.database.deleteDocument(p1); // delete

    await p.promise;

    expect(seen).toEqual([
      { userId: 'uA', postId: 'p1', exists: true },
      { userId: 'uA', postId: 'p2', exists: true },
      { userId: 'uA', postId: 'p1', exists: false },
    ]);
  });

  it('does not fire for non-matching paths (and waits for async trigger queue)', async () => {
    const hits: TriggerArg[] = [];
    const unexpected = new Deferred<void>();

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'teams/{teamId}/roster/{memberId}',
      callback: (arg: TriggerArg) => {
        hits.push(arg);
        unexpected.resolve(); // If this fires, the test should fail.
      },
    });

    // All writes below are VALID document paths but should NOT match the registered route:
    db.database.setDocument('teams/t1/metadata/info', { a: 1 }); // "metadata/info" ≠ "roster/{memberId}"
    db.database.setDocument('teams/t1/rosterMeta/m1', { ok: true }); // different collection name ("rosterMeta")
    db.database.setDocument('users/u1/roster/m1', { nope: true }); // different top-level collection ("users")
    db.database.deleteDocument('users/u1/roster/m1');

    // Race a short sleep vs. the unexpected trigger. If callback fires, fail fast.
    await Promise.race([
      unexpected.promise.then(() => {
        throw new Error('Trigger unexpectedly fired for non-matching paths');
      }),
      sleep(40),
    ]);

    expect(hits).toHaveLength(0);
  });

  it('multiple triggers registered on the same route all fire in registration order', async () => {
    const order: string[] = [];
    const p = deferUntil(3);

    const db = env.createDatabase();

    db.database.registerTrigger({
      route: 'rooms/{roomId}',
      callback: () => {
        order.push('A');
        p.inc();
      },
    });

    db.database.registerTrigger({
      route: 'rooms/{roomId}',
      callback: () => {
        order.push('B');
        p.inc();
      },
    });

    db.database.registerTrigger({
      route: 'rooms/{roomId}',
      callback: () => {
        order.push('C');
        p.inc();
      },
    });

    db.database.setDocument('rooms/r1', { name: 'Alpha' });

    await p.promise;

    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('both a specific pattern and a wildcard pattern may match the same write', async () => {
    const hits: string[] = [];
    const p = deferUntil(2);

    const db = env.createDatabase();

    db.database.registerTrigger({
      route: 'users/{userId}/data/profile',
      callback: () => {
        hits.push('specific');
        p.inc();
      },
    });

    db.database.registerTrigger({
      route: 'users/{userId}/data/{docId}',
      callback: (arg: TriggerArg) => {
        if (arg.params.docId === 'profile') {
          hits.push('wildcard');
          p.inc();
        }
      },
    });

    db.database.setDocument('users/u7/data/profile', { ok: true });

    await p.promise;

    expect(hits.sort()).toEqual(['specific', 'wildcard'].sort());
  });

  it('supports multiple independent databases from the same env', async () => {
    const aHits: string[] = [];
    const bHits: string[] = [];
    const p = deferUntil(2);

    const dbA = env.createDatabase(undefined, 'db1');
    const dbB = env.createDatabase(undefined, 'db2');

    dbA.database.registerTrigger({
      route: 'x/{id}',
      callback: (arg: TriggerArg) => {
        aHits.push(arg.params.id);
        p.inc();
      },
    });

    dbB.database.registerTrigger({
      route: 'x/{id}',
      callback: (arg: TriggerArg) => {
        bHits.push(arg.params.id);
        p.inc();
      },
    });

    dbA.database.setDocument('x/a1', { a: true });
    dbB.database.setDocument('x/b1', { b: true });

    await p.promise;

    expect(aHits).toEqual(['a1']);
    expect(bHits).toEqual(['b1']);
  });

  it('does not fire for a second delete of a non-existent document', async () => {
    const events: Array<{ exists: boolean; id: string }> = [];
    const p = deferUntil(2); // expect exactly: create, first delete
    const unexpected = new Deferred<void>();

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'notes/{id}',
      callback: (arg: TriggerArg) => {
        events.push({ exists: arg.doc.exists, id: arg.params.id });
        // If a 3rd event arrives, fail fast:
        if (events.length > 2) unexpected.resolve();
        p.inc();
      },
    });

    db.database.setDocument('notes/n1', { t: 1 }); // create -> event #1
    db.database.deleteDocument('notes/n1'); // delete (exists->false) -> event #2
    db.database.deleteDocument('notes/n1'); // delete non-existent -> should NOT fire

    await p.promise;

    // Wait a bit to ensure no late 3rd event shows up
    await Promise.race([
      unexpected.promise.then(() => {
        throw new Error('Void delete fired a trigger');
      }),
      sleep(40),
    ]);

    expect(events[0]).toEqual({ exists: true, id: 'n1' });
    expect(events[1]).toEqual({ exists: false, id: 'n1' });
    expect(events).toHaveLength(2);
  });

  it('does not cross-fire between siblings when writing multiple documents', async () => {
    const seen: string[] = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'cats/{catId}',
      callback: (arg: TriggerArg) => {
        seen.push(arg.params.catId);
        p.inc();
      },
    });

    db.database.setDocument('cats/whiskers', { age: 3 });
    db.database.setDocument('cats/mittens', { age: 5 });

    await p.promise;

    expect(seen).toEqual(['whiskers', 'mittens']);
  });

  it('handles deeply nested collections with multiple params', async () => {
    const got: Array<{ a: string; b: string; c: string; exists: boolean }> = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'a/{A}/b/{B}/c/{C}',
      callback: (arg: TriggerArg) => {
        const { A: a, B: b, C: c } = arg.params;
        got.push({ a, b, c, exists: arg.doc.exists });
        p.inc();
      },
    });

    const path = 'a/one/b/two/c/three'; // 6 segments
    db.database.setDocument(path, { ok: true });
    db.database.deleteDocument(path);

    await p.promise;

    expect(got).toEqual([
      { a: 'one', b: 'two', c: 'three', exists: true },
      { a: 'one', b: 'two', c: 'three', exists: false },
    ]);
  });

  it('triggers for sibling wildcard but not for parent prefix (no implicit prefix matching)', async () => {
    const hits: string[] = [];
    const p = deferUntil(1);

    const db = env.createDatabase();

    // Should NOT match writes to ".../meta/settings"
    db.database.registerTrigger({
      route: 'projects/{pid}/docs/{docId}',
      callback: () => {
        hits.push('docs');
        p.inc();
      },
    });

    // This one SHOULD match
    db.database.registerTrigger({
      route: 'projects/{pid}/docs/{docId}/meta/{metaDoc}',
      callback: () => {
        hits.push('meta');
        p.inc();
      },
    });

    // Write to a child document under "meta"
    db.database.setDocument('projects/p1/docs/d1/meta/settings', { v: 1 });

    await p.promise;

    expect(hits).toEqual(['meta']);
  });

  //
  it('batch: [create, update] to the same doc fires once for the last op (exists=true)', async () => {
    const calls: Array<{ exists: boolean; id: string }> = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'users/{userId}/data/profile',
      callback: (arg: TriggerArg) => {
        calls.push({ exists: arg.doc.exists, id: arg.params.userId });
        p.inc();
      },
    });

    // Same path, two writes in a single batch: create then update.
    db.database.batchWrite([
      { path: 'users/u100/data/profile', data: { name: 'A', age: 1 } }, // create
      { path: 'users/u100/data/profile', data: { name: 'A', age: 2 } }, // update (last op wins)
    ]);

    await Promise.race([p.promise, sleep(40)]);
    expect(calls).toEqual([{ exists: true, id: 'u100' }]);
  });

  it('batch: [create, delete] to the same doc does not fire because post-batch state is unchanged', async () => {
    const calls: Array<{ exists: boolean; id: string }> = [];
    const p = deferUntil(1);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'users/{userId}/data/profile',
      callback: (arg: TriggerArg) => {
        calls.push({ exists: arg.doc.exists, id: arg.params.userId });
        p.inc();
      },
    });

    // Same path, two writes in a single batch: create then delete.
    db.database.batchWrite([
      { path: 'users/u200/data/profile', data: { version: 2 } }, // create
      'users/u200/data/profile', // delete (last op wins)
    ]);

    await Promise.race([p.promise, sleep(40)]);
    expect(calls.length).toBe(0);
  });

  it('batch: [update, delete] fires once (delete wins); sibling doc unaffected', async () => {
    const events: Array<{ tag: string; exists: boolean; id: string }> = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.setDocument('notes/n1', { v: 1 }); // create

    db.database.registerTrigger({
      route: 'notes/{id}',
      callback: (arg: TriggerArg) => {
        events.push({
          tag: 'notes',
          exists: arg.doc.exists,
          id: arg.params.id,
        });
        p.inc();
      },
    });
    db.database.registerTrigger({
      route: 'tasks/{id}',
      callback: (arg: TriggerArg) => {
        events.push({
          tag: 'tasks',
          exists: arg.doc.exists,
          id: arg.params.id,
        });
        p.inc();
      },
    });

    // Three writes to notes/n1 within the same batch: only the last (delete) should trigger.
    // One independent write to tasks/t1 should also trigger.
    db.database.batchWrite([
      { path: 'notes/n1', data: { v: 2 } }, // update
      'notes/n1', // delete (last op wins → exists=false)
      { path: 'tasks/t1', data: { done: false } }, // separate doc → exists=true
    ]);

    await p.promise;

    // Order of callbacks should match registration order within each route,
    // but across routes the relative ordering is not critical here.
    // Assert one event per *final* document path outcome.
    const sorted = events.sort((a, b) => a.tag.localeCompare(b.tag));
    expect(sorted).toEqual([
      { tag: 'notes', exists: false, id: 'n1' },
      { tag: 'tasks', exists: true, id: 't1' },
    ]);
  });

  it('batch: multiple paths with duplicates — only final op per path fires once each', async () => {
    const hits: Array<{ path: string; exists: boolean }> = [];
    const p = deferUntil(2);

    const db = env.createDatabase();
    db.database.registerTrigger({
      route: 'cats/{catId}',
      callback: (arg: TriggerArg) => {
        hits.push({ path: `cats/${arg.params.catId}`, exists: arg.doc.exists });
        p.inc();
      },
    });

    db.database.batchWrite([
      { path: 'cats/c1', data: { a: 1 } }, // create c1
      { path: 'cats/c2', data: { a: 1 } }, // create c2
      { path: 'cats/c1', data: { a: 2 } }, // update c1
      'cats/c2', // delete c2
      { path: 'cats/c3', data: { a: 9 } }, // create c3
      { path: 'cats/c1', data: { a: 3 } }, // final update c1
      // Final ops per path: c1 -> update (exists=true), c2 -> delete (exists=false), c3 -> create (exists=true)
    ]);

    await p.promise;

    // Order across paths isn't essential; assert final state per path fired exactly once.
    const byPath = Object.fromEntries(hits.map((h) => [h.path, h.exists]));
    expect(byPath).toEqual({
      'cats/c1': true,
      'cats/c3': true,
    });
    expect(hits).toHaveLength(2);
  });
});
