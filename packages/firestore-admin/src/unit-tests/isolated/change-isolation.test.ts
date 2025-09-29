/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DocumentData } from 'firebase-admin/firestore';
import { DatabaseDirect, FirestoreMock } from '../..';
import type { MetaDocument, MetaDocumentExists } from '../../';

describe('Change isolation tests (DatabaseDirect / MetaDocument)', () => {
  const env = new FirestoreMock();
  let db!: DatabaseDirect;

  beforeEach(() => {
    db = env.createDatabase().database;
  });

  afterEach(() => {
    env.deleteAll();
  });

  const P = 'col/doc';

  const deepFreeze = <T>(v: T): T => {
    if (v && typeof v === 'object') {
      Object.freeze(v as object);
      for (const k of Object.keys(v as any)) {
        deepFreeze((v as any)[k]);
      }
    }
    return v;
  };

  const expectVersionAsc = (
    a: MetaDocument<DocumentData>,
    b: MetaDocument<DocumentData>
  ) => {
    expect(typeof a.version).toBe('number');
    expect(typeof b.version).toBe('number');
    expect(b.version).toBeGreaterThan(a.version);
  };

  it('set → update: versions ascend; previous chains correctly; data/getData value-equal; cloneData holds past snapshot', () => {
    // --- initial set
    const initial = { a: 1, nested: { x: 1, k: ['z'] } };
    const src1 = {
      ...initial,
      nested: { ...initial.nested, k: [...initial.nested.k] },
    };
    const m1 = db.setDocument(P, src1) as MetaDocumentExists;
    // 1) version existence and monotonicity baseline
    expect(typeof m1.version).toBe('number');
    expect(m1.exists).toBe(true);

    // 2) data vs getData value-equality (same values, ref not required)
    expect(m1.data).toEqual(m1.cloneData());
    expect(m1.data).toEqual(initial);

    // 2b) getData() must be safe to mutate (should not affect stored state)
    const gd1 = m1.cloneData();
    (gd1 as any).mutateProbe = 'local-only';
    expect(m1.data).toEqual(initial); // unchanged

    // 2c) source object isolation: later mutation of the original input must not affect stored data
    (src1.nested as any).x = 999;
    (src1.nested.k as any[]).push('leak?');
    expect(m1.data).toEqual(initial);

    // 2d) cloneData() must hold a stable snapshot even after subsequent writes
    const snap1 = m1.cloneData();
    expect(snap1).toEqual(initial);

    // --- update (replace) with new payload
    const updated = { a: 2, nested: { y: 2 } };
    const src2 = deepFreeze({ ...updated, nested: { ...updated.nested } });
    const m2 = db.setDocument(P, src2) as MetaDocumentExists;

    // 1) version ascends; previous is populated and consistent
    expectVersionAsc(m1, m2);
    expect(m2.previous?.exists).toBe(true);
    expect(m2.previous?.data).toEqual(initial);
    expect(m2.data).toEqual(updated);

    // 2) data/getData value-equality on same instance
    expect(m2.data).toEqual(m2.cloneData());

    // 3) previous.version/data/getData consistent with expectation
    const prev2 = m2.previous as MetaDocumentExists;
    expect(prev2.version).toBe(m1.version);
    expect(prev2.cloneData()).toEqual(prev2.data);
    expect(prev2.cloneData()).toEqual(initial);

    // cloneData snapshot from m1 must remain the old image after m2 write
    expect(snap1).toEqual(initial);

    // mutating m2.getData() (caller-side) must not leak into m2.data
    const gd2 = m2.cloneData()!;
    (gd2.nested as any).y = 12345;
    expect(m2.data).toEqual(updated);
  });

  it('delete: current is non-existent; previous carries last existing snapshot; further writes do not mutate delete-previous', () => {
    const v1 = { a: 1 };
    const v2 = { a: 2, b: { m: 9 } };

    const m1 = db.setDocument(P, v1) as MetaDocumentExists;
    const m2 = db.setDocument(P, v2) as MetaDocumentExists;
    expectVersionAsc(m1, m2);

    // delete current
    const md = db.deleteDocument(P);
    expect(md.exists).toBe(false);
    // previous should be the last existing (m2)
    expect(md.previous?.exists).toBe(true);
    expect(md.previous?.data).toEqual(v2);
    expect((md.previous as MetaDocumentExists).cloneData()).toEqual(v2);
    expect((md.previous as MetaDocumentExists).version).toBe(m2.version);

    // mutate a local copy; ensure it doesn't leak into stored previous
    const local = (md.previous as MetaDocumentExists).cloneData()!;
    (local.b as any).m = -1;
    expect((md.previous as MetaDocumentExists).data).toEqual(v2);

    // re-create with new content; delete-previous must remain unchanged
    const v3 = { z: true };
    const m3 = db.setDocument(P, v3) as MetaDocumentExists;
    expect(m3.exists).toBe(true);
    expect(m3.data).toEqual(v3);

    // the old delete result's previous (captured earlier) should still reflect v2
    expect((md.previous as MetaDocumentExists).data).toEqual(v2);
    // versions are strictly increasing across lifecycle
    expectVersionAsc(m2, m3);
  });

  it('sequential updates: previous is per-op (no chaining); linear history holds without bleed-through', () => {
    const v1 = { val: 1, obj: { a: 1 } };
    const v2 = { val: 2, obj: { a: 2 } };
    const v3 = { val: 3, obj: { a: 3 } };

    const m1 = db.setDocument(P, v1) as MetaDocumentExists;
    const m2 = db.setDocument(P, v2) as MetaDocumentExists;
    const m3 = db.setDocument(P, v3) as MetaDocumentExists;

    // Version monotonic
    expectVersionAsc(m1, m2);
    expectVersionAsc(m2, m3);

    // Current is v3
    expect(m3.data).toEqual(v3);
    expect(m3.cloneData()).toEqual(v3);

    // Per-op previous:
    // m3.previous === v2 (but p2.previous is not populated/linked)
    const p2 = m3.previous as MetaDocumentExists;
    expect(p2?.exists).toBe(true);
    expect(p2?.data).toEqual(v2);
    expect(p2?.cloneData()).toEqual(v2);
    expect((p2 as any)?.previous).toBeUndefined(); // important: no chaining

    // m2.previous === v1 (access prior op's previous directly)
    const p1 = m2.previous as MetaDocumentExists | undefined;
    expect(p1?.exists).toBe(true);
    expect(p1?.data).toEqual(v1);
    expect(p1?.cloneData()).toEqual(v1);

    // Ensure forward writes did not mutate backward snapshots
    const gdCopy = p2.cloneData()!;
    (gdCopy.obj as any).a = 2222;
    expect(p2.data).toEqual(v2); // unchanged
    expect(m2.data).toEqual(v2); // unchanged
    expect(m1.data).toEqual(v1); // unchanged
  });

  it('input object and nested arrays/objects are defensively copied (no aliasing to caller state)', () => {
    // Caller-provided object with deep structure
    const input: DocumentData = {
      title: 't1',
      arr: [{ n: 1 }, { n: 2 }],
      map: { k1: { q: 9 } },
    };

    const m1 = db.setDocument(P, input) as MetaDocumentExists;
    // mutate caller's object after write
    input.title = 'MUTATED';
    (input.arr as any[])[0].n = 111;
    (input.map as any).k1.q = -1;
    (input.arr as any[]).push({ n: 3 });

    // stored state must remain the original values
    expect(m1.data).toEqual({
      title: 't1',
      arr: [{ n: 1 }, { n: 2 }],
      map: { k1: { q: 9 } },
    });

    // getData() returns a safe copy (mutations must not affect m1.data)
    const copy = m1.cloneData()!;
    (copy.arr as any[])[0].n = 9999;
    (copy.map as any).k1.q = 1234;
    expect(m1.data).toEqual({
      title: 't1',
      arr: [{ n: 1 }, { n: 2 }],
      map: { k1: { q: 9 } },
    });

    // cloneData() snapshot remains stable through subsequent writes
    const snapshot = m1.cloneData();
    const m2 = db.setDocument(P, { changed: true }) as MetaDocumentExists;
    expectVersionAsc(m1, m2);
    expect(snapshot).toEqual({
      title: 't1',
      arr: [{ n: 1 }, { n: 2 }],
      map: { k1: { q: 9 } },
    });
  });

  it('delete chain: delete → delete does not corrupt previous, and missing previous stays missing', () => {
    // delete when missing: previous should typically be undefined or missing
    const d1 = db.deleteDocument(P);
    expect(d1.exists).toBe(false);
    // tolerant: either no previous or previous.exists === false depending on implementation;
    // assert that no existing data is falsely reported
    if (d1.previous) {
      expect(d1.previous.exists).toBe(false);
    }

    // create, then delete twice in a row
    const m1 = db.setDocument(P, { a: 1 }) as MetaDocumentExists;
    const d2 = db.deleteDocument(P);
    expect(d2.exists).toBe(false);
    expect(d2.hasChanges).toBe(true);
    expect(d2.previous?.exists).toBe(true);
    expect(d2.previous?.data).toEqual({ a: 1 });

    const d3 = db.deleteDocument(P);
    expect(d3.exists).toBe(false);
    // Second delete should not invent new previous existing data
    if (d3.previous) {
      expect(d3.previous.exists).toBe(false);
    }

    // Versions are strictly monotonic over the sequence
    expectVersionAsc(m1, d2);
    expect(d3.version).toBe(d2.version);
    expect(d3.hasChanges).toBe(false);
    expect(d3.previous).toBeUndefined();
  });

  it('batchSet then individual set: earlier snapshots remain intact (no bleed-through across operations)', () => {
    const [m1] = db.batchSet({
      path: P,
      data: { v: 1 },
    }) as MetaDocumentExists[];
    const snap = m1.cloneData();
    expect(snap).toEqual({ v: 1 });

    const m2 = db.setDocument(P, { v: 2, extra: true }) as MetaDocumentExists;
    expectVersionAsc(m1, m2);

    // the earlier clone remains the old image
    expect(snap).toEqual({ v: 1 });

    // m2.previous is exactly v1, and m1 is not retro-mutated
    expect(m2.previous?.data).toEqual({ v: 1 });
    expect(m1.data).toEqual({ v: 1 });
  });
});
