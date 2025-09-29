import { DocumentData } from 'firebase-admin/firestore';
import { FirestoreController, FirestoreMock } from '../..';
import { MetaDocumentExists } from '../../lib/_internal/data-accessor';

type Stats = ReturnType<FirestoreController['database']['stats']>;

function expectOps(
  stats: Stats,
  {
    writes = 0,
    reads = 0,
    deletes = 0,
    noopReads = 0,
    noopWrites = 0,
    noopDeletes = 0,
  }: Partial<Stats> = {}
) {
  expect(stats.writes).toBe(writes);
  expect(stats.reads).toBe(reads);
  expect(stats.deletes).toBe(deletes);
  expect(stats.noopReads).toBe(noopReads);
  expect(stats.noopWrites).toBe(noopWrites);
  expect(stats.noopDeletes).toBe(noopDeletes);
}

// Type guard helpers (avoid `any`)
function isExisting<T extends DocumentData = DocumentData>(m: {
  exists: boolean;
}): m is MetaDocumentExists<T> {
  return m.exists === true;
}

describe('DatabaseStats > OperationalStats', () => {
  let env!: FirestoreMock;

  beforeEach(() => {
    env = new FirestoreMock();
  });

  //
  // Baseline & reset
  //
  describe('Baseline & reset()', () => {
    it('starts at zero for all operation counters', () => {
      const ctrl = env.createDatabase();
      const s = ctrl.database.stats();
      expectOps(s, {
        writes: 0,
        reads: 0,
        deletes: 0,
        noopReads: 0,
        noopWrites: 0,
        noopDeletes: 0,
      });
    });

    it('returns to zero after reset()', () => {
      const ctrl = env.createDatabase();

      ctrl.database.setDocument('col/a', { i: 1 });
      ctrl.database.deleteDocument('col/a');
      ctrl.database.deleteDocument('col/missing'); // noop delete

      const before = ctrl.database.stats();
      expect(
        before.writes + before.deletes + before.noopDeletes
      ).toBeGreaterThan(0);

      ctrl.database.reset();
      const after = ctrl.database.stats();
      expectOps(after, {
        writes: 0,
        reads: 0,
        deletes: 0,
        noopReads: 0,
        noopWrites: 0,
        noopDeletes: 0,
      });
    });

    it('clear() resets structural stats but preserves operational counters (and counters continue from previous values)', () => {
      const ctrl = env.createDatabase();

      // Build up all operational counters
      // writes + noopWrites
      ctrl.database.setDocument('x/a', { v: 1 }); // writes: 1
      ctrl.database.setDocument('x/a', { v: 1 }); // noopWrites: 1
      ctrl.database.setDocument('x/b', { v: 2 }); // writes: 2

      // deletes + noopDeletes
      ctrl.database.deleteDocument('x/b'); // deletes: 1
      ctrl.database.deleteDocument('x/missing'); // noopDeletes: 1

      // reads + noopReads (direct)
      expect(ctrl.database.getDocument('x/a').exists).toBe(true); // reads: 1
      expect(ctrl.database.getDocument('x/none').exists).toBe(false); // noopReads: 1

      // query: one non-empty, one empty
      const delivered = ctrl.database.query({
        collectionId: 'x',
        allDescendants: true,
        predicate: () => true,
      });
      expect(delivered.length).toBe(1); // reads: +1 (doc 'a') → reads: 2

      const empty = ctrl.database.query({
        collectionId: 'x',
        allDescendants: true,
        predicate: () => false,
      });
      expect(empty.length).toBe(0); // noopReads: +1 → noopReads: 2

      // Sanity: structural non-zero before clear()
      const before = ctrl.database.stats();
      expect(before.documentCount).toBeGreaterThan(0);
      expect(before.collectionCount).toBeGreaterThan(0);

      // Expected counters before clear()
      expect(before.writes).toBe(2); // a (create), b (create)
      expect(before.noopWrites).toBe(1); // redundant set of a
      expect(before.deletes).toBe(1); // deleted b
      expect(before.noopDeletes).toBe(1); // delete missing
      expect(before.reads).toBe(2); // get(a) + 1 doc from query
      expect(before.noopReads).toBe(2); // get(missing) + empty query

      // Act: clear() — should reset structure only
      ctrl.database.clear();

      const after = ctrl.database.stats();

      // Structural stats reset
      expect(after.documentCount).toBe(0);
      expect(after.collectionCount).toBe(0);
      expect(after.stubDocumentCount).toBe(0);
      expect(after.stubCollectionCount).toBe(0);

      // Operational counters preserved
      expect(after.writes).toBe(before.writes);
      expect(after.noopWrites).toBe(before.noopWrites);
      expect(after.deletes).toBe(before.deletes);
      expect(after.noopDeletes).toBe(before.noopDeletes);
      expect(after.reads).toBe(before.reads);
      expect(after.noopReads).toBe(before.noopReads);

      // Further operations continue from preserved totals (not reset)
      ctrl.database.setDocument('z/c', { v: 3 }); // writes +1
      const afterMore = ctrl.database.stats();
      expect(afterMore.writes).toBe(before.writes + 1);
      expect(afterMore.documentCount).toBe(1);
      expect(afterMore.collectionCount).toBe(1);
    });
  });

  //
  // Writes
  //
  describe('Writes (create/update vs noop)', () => {
    it('create counts as write', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('w/a', { v: 1 });
      const s = ctrl.database.stats();
      expectOps(s, { writes: 1 });
    });

    it('update that changes data increments writes', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('w/a', { v: 1 });
      ctrl.database.setDocument('w/a', { v: 2 }); // change
      const s = ctrl.database.stats();
      expectOps(s, { writes: 2, noopWrites: 0 });
    });

    it('redundant write (no change) increments noopWrites', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('w/a', { v: 1 });
      ctrl.database.setDocument('w/a', { v: 1 }); // identical
      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, noopWrites: 1 });
    });

    it('partial overwrite that leaves final state identical counts as noopWrites', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('w/a', { a: 1, b: 2, nested: { x: true } });
      // same materialized shape again
      ctrl.database.setDocument('w/a', { a: 1, b: 2, nested: { x: true } });
      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, noopWrites: 1 });
    });

    it('batchSet: counts only effective changes as writes; identical docs become noopWrites', () => {
      const ctrl = env.createDatabase();

      // First seed
      ctrl.database.batchSet(
        { path: 'bw/a', data: { v: 1 } },
        { path: 'bw/b', data: { v: 2 } }
      );

      // Second batch: one no-op, one change, one new
      ctrl.database.batchSet(
        { path: 'bw/a', data: { v: 1 } }, // noop
        { path: 'bw/b', data: { v: 3 } }, // change
        { path: 'bw/c', data: { v: 0 } } // new
      );

      const s = ctrl.database.stats();
      // writes: first batch (2) + second batch (change 1 + new 1) = 4
      // noopWrites: (1)
      expectOps(s, {
        writes: 4,
        noopWrites: 1,
        deletes: 0,
        noopDeletes: 0,
        reads: 0,
        noopReads: 0,
      });
    });
  });

  //
  // Deletes
  //
  describe('Deletes vs noopDeletes', () => {
    it('delete existing doc increments deletes', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('d/a', { v: 1 });
      ctrl.database.deleteDocument('d/a');
      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, deletes: 1 });
    });

    it('delete non-existent doc increments noopDeletes', () => {
      const ctrl = env.createDatabase();
      ctrl.database.deleteDocument('d/missing');
      const s = ctrl.database.stats();
      expectOps(s, { noopDeletes: 1 });
    });

    it('delete existing then delete again → deletes:1, noopDeletes:1', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('d/a', { v: 1 });
      ctrl.database.deleteDocument('d/a');
      ctrl.database.deleteDocument('d/a'); // now missing
      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, deletes: 1, noopDeletes: 1 });
    });

    it('batchDelete: mixes deletes and noopDeletes', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('bd/a', { v: 1 });
      ctrl.database.setDocument('bd/b', { v: 2 });

      // delete a + b + a (again) + missing
      ctrl.database.batchDelete('bd/a', 'bd/b', 'bd/a', 'bd/missing');

      const s = ctrl.database.stats();
      // deletes: a, b => 2
      // noopDeletes: a (again), missing => 2
      expectOps(s, { writes: 2, deletes: 2, noopDeletes: 2 });
    });
  });

  //
  // Direct lookups (getDocument)
  //
  describe('Direct reads (getDocument)', () => {
    it('existing doc read increments reads', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('r/a', { v: 1 });

      const snap = ctrl.database.getDocument('r/a');
      expect(snap.exists).toBe(true);

      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, reads: 1 });
    });

    it('missing doc read increments noopReads', () => {
      const ctrl = env.createDatabase();

      const snap = ctrl.database.getDocument('r/missing');
      expect(snap.exists).toBe(false);

      const s = ctrl.database.stats();
      expectOps(s, { noopReads: 1 });
    });

    it('multiple getDocument calls increment reads/noopReads per call', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('r/a', { v: 1 });

      ctrl.database.getDocument('r/a'); // reads++
      ctrl.database.getDocument('r/a'); // reads++
      ctrl.database.getDocument('r/missing'); // noopReads++
      ctrl.database.getDocument('r/missing'); // noopReads++

      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, reads: 2, noopReads: 2 });
    });

    it('read after delete (now missing) increments noopReads', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('r/x', { v: 1 });
      ctrl.database.deleteDocument('r/x');

      const snap = ctrl.database.getDocument('r/x');
      expect(snap.exists).toBe(false);

      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, deletes: 1, noopReads: 1 });
    });
  });

  //
  // Query reads (query())
  //
  describe('Query reads (query())', () => {
    // Helper to run queries with required predicate
    const allIn = (collectionId: string) => ({
      collectionId,
      allDescendants: true,
      predicate: () => true,
    });

    it('collection query with matches increments reads per delivered doc', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('q/a', { v: 1 });
      ctrl.database.setDocument('q/b', { v: 2 });
      ctrl.database.setDocument('q/c', { v: 3 });

      const results = ctrl.database.query(allIn('q'));
      expect(results.length).toBe(3);

      const s = ctrl.database.stats();
      // 3 docs delivered → reads += 3
      expectOps(s, { writes: 3, reads: 3, noopReads: 0 });
    });

    it('simple predicate query counts reads per delivered doc', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('q/a', { v: 1 });
      ctrl.database.setDocument('q/b', { v: 2 });
      ctrl.database.setDocument('q/c', { v: 3 });

      const results = ctrl.database.query({
        collectionId: 'q',
        allDescendants: true,
        predicate: (m) => isExisting<typeof m.data>(m) && m.data.v === 2,
      });

      expect(results.length).toBe(1);

      const s = ctrl.database.stats();
      // total delivered docs across queries = 1
      expectOps(s, { writes: 3, reads: 1, noopReads: 0 });
    });

    it('query with no matches increments noopReads by 1 (not per candidate)', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('q/a', { v: 1 });
      ctrl.database.setDocument('q/b', { v: 2 });

      const empty = ctrl.database.query({
        collectionId: 'q',
        allDescendants: true,
        predicate: (m) => isExisting<typeof m.data>(m) && m.data.v === 999,
      });

      expect(empty.length).toBe(0);

      const s = ctrl.database.stats();
      expectOps(s, { writes: 2, noopReads: 1 });
    });

    it('multiple empty queries each add 1 to noopReads', () => {
      const ctrl = env.createDatabase();
      ctrl.database.setDocument('q/a', { t: 'x' });

      const r1 = ctrl.database.query({
        collectionId: 'q',
        allDescendants: true,
        predicate: (m) => isExisting<typeof m.data>(m) && m.data.t === 'y',
      });

      const r2 = ctrl.database.query({
        collectionId: 'q',
        allDescendants: true,
        predicate: (m) => isExisting<typeof m.data>(m) && m.data.t === 'z',
      });

      expect(r1.length).toBe(0);
      expect(r2.length).toBe(0);

      const s = ctrl.database.stats();
      expectOps(s, { writes: 1, noopReads: 2 });
    });
  });

  //
  // Mixed flows & sanity
  //
  describe('Mixed flows & sanity checks', () => {
    it('create → noop write → update → get → delete → noop delete', () => {
      const ctrl = env.createDatabase();

      // create (write)
      ctrl.database.setDocument('mix/a', { v: 1 });

      // noop write (identical)
      ctrl.database.setDocument('mix/a', { v: 1 });

      // update (write)
      ctrl.database.setDocument('mix/a', { v: 2 });

      // successful read
      const got = ctrl.database.getDocument('mix/a');
      expect(got.exists).toBe(true);

      // delete existing
      ctrl.database.deleteDocument('mix/a');

      // noop delete again
      ctrl.database.deleteDocument('mix/a');

      const s = ctrl.database.stats();
      expectOps(s, {
        writes: 2, // create + update
        noopWrites: 1, // redundant set
        reads: 1, // get existing
        deletes: 1, // first delete
        noopDeletes: 1, // second delete
        noopReads: 0,
      });
    });

    it('two noop reads on missing → create → successful read → noop write → update', () => {
      const ctrl = env.createDatabase();

      // missing reads
      expect(ctrl.database.getDocument('mix/b').exists).toBe(false);
      expect(ctrl.database.getDocument('mix/b').exists).toBe(false);

      // create
      ctrl.database.setDocument('mix/b', { v: 1 });

      // successful read
      expect(ctrl.database.getDocument('mix/b').exists).toBe(true);

      // noop write
      ctrl.database.setDocument('mix/b', { v: 1 });

      // update
      ctrl.database.setDocument('mix/b', { v: 2 });

      const s = ctrl.database.stats();
      expectOps(s, {
        writes: 2, // create + update
        noopWrites: 1, // redundant
        reads: 1, // single successful get
        noopReads: 2, // two misses before create
        deletes: 0,
        noopDeletes: 0,
      });
    });

    it('query reads add to reads; empty queries add to noopReads alongside direct gets', () => {
      const ctrl = env.createDatabase();

      // seed
      ctrl.database.setDocument('m/a', { k: 1 });
      ctrl.database.setDocument('m/b', { k: 2 });

      // direct successful read
      expect(ctrl.database.getDocument('m/a').exists).toBe(true);

      // match-all query (2 docs delivered)
      const all = ctrl.database.query({
        collectionId: 'm',
        allDescendants: true,
        predicate: () => true,
      });
      expect(all.length).toBe(2);

      // empty query
      const none = ctrl.database.query({
        collectionId: 'm',
        allDescendants: true,
        predicate: (m) => isExisting<typeof m.data>(m) && m.data.k === 999,
      });
      expect(none.length).toBe(0);

      const s = ctrl.database.stats();
      // writes: 2 (a,b)
      // reads: 1 (direct) + 2 (query) = 3
      // noopReads: 1 (empty query)
      expectOps(s, { writes: 2, reads: 3, noopReads: 1 });
    });
  });
});
