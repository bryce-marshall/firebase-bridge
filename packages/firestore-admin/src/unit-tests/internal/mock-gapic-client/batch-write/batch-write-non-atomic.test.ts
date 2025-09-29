/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Status } from 'google-gax';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';

describe('MockGapicClient.batchWrite — non-atomic behavior', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'DatabaseOne' });
  });

  it('allows duplicate document paths without error (set with merge semantics)', async () => {
    const localPath = 'users/user1';
    const path = Mock.context.toGapicPath(localPath);

    const [res] = await Mock.client.batchWrite({
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 1 }),
          },
          updateMask: { fieldPaths: ['a'] }, // set(..., { merge: true }) for top-level 'a'
        },
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ b: 2 }),
          },
          updateMask: { fieldPaths: ['b'] }, // merge in 'b'
        },
      ],
    });

    expect(res.status).toHaveLength(2);
    expect(res.status!.every((s) => s.code === Status.OK)).toBe(true);
    expect(Mock.db.getDocument(localPath).data).toEqual({ a: 1, b: 2 });
  });

  it('allows duplicate document paths without error (update semantics)', async () => {
    const localPath = 'users/user1';
    const path = Mock.context.toGapicPath(localPath);
    const [res] = await Mock.client.batchWrite({
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 1 }),
          },
        },
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ b: 2 }),
          },
        },
      ],
    });

    expect(res.status).toHaveLength(2);
    expect(res.status!.every((s) => s.code === Status.OK)).toBe(true);
    expect(Mock.db.getDocument(localPath).data).toEqual({ b: 2 });
  });

  it('returns per-write commitTime and writeResults', async () => {
    const path = Mock.context.toGapicPath('users/user2');
    const [res] = await Mock.client.batchWrite({
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 123 }),
          },
        },
      ],
    });

    expect(res.writeResults).toHaveLength(1);
    expect(res.writeResults![0].updateTime).toBeDefined();
    expect(res.status![0].code).toBe(Status.OK);
  });

  it('evaluates preconditions per-write', async () => {
    const path = Mock.context.toGapicPath('users/user3');

    const [res] = await Mock.client.batchWrite({
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 1 }),
          },
        },
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 2 }),
          },
          currentDocument: { exists: false },
        },
      ],
    });

    expect(res.status![0].code).toBe(Status.OK);
    expect(res.status![1].code).toBe(Status.ALREADY_EXISTS);
    expect(Mock.db.getDocument('users/user3').data).toEqual({ a: 1 });
  });

  it('fails a write with stale lastUpdateTime after a prior write', async () => {
    const path = Mock.context.toGapicPath('users/user4');

    // First write to create document
    const [initial] = await Mock.client.batchWrite({
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 1 }),
          },
        },
      ],
    });

    const staleTime = initial.writeResults![0].updateTime!;
    Mock.time.advance();
    // Second batchWrite: first write updates doc, second uses stale precondition
    const [res] = await Mock.client.batchWrite({
      writes: [
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 2 }),
          },
        },
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ b: 3 }),
          },
          currentDocument: { updateTime: staleTime },
        },
      ],
    });

    expect(res.status![0].code).toBe(Status.OK);
    expect(res.status![1].code).toBe(Status.FAILED_PRECONDITION);
    expect(Mock.db.getDocument('users/user4').data).toEqual({ a: 2 });
  });

  it('applies transform in sequence with other writes', async () => {
    const path = Mock.context.toGapicPath('users/user5');

    const [res] = await Mock.client.batchWrite({
      writes: [
        // set({a:1}, {merge:true})
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ a: 1 }),
          },
          updateMask: { fieldPaths: ['a'] }, // branch merge
        },
        // transform only, non-destructive (mask present but empty => no-op merge)
        {
          update: { name: path, fields: {} },
          updateMask: { fieldPaths: [] }, // keep existing fields
          updateTransforms: [
            { fieldPath: 'lastModified', setToServerValue: 'REQUEST_TIME' },
          ],
        },
        // set({b:2}, {merge:true})
        {
          update: {
            name: path,
            fields: Mock.context.serializer.encodeFields({ b: 2 }),
          },
          updateMask: { fieldPaths: ['b'] }, // branch merge
        },
      ],
    });

    expect(res.status!.every((s) => s.code === Status.OK)).toBe(true);

    const doc = Mock.db.getDocument('users/user5').data!;
    expect(doc.a).toBe(1);
    expect(doc.b).toBe(2);
    expect(doc.lastModified).toBeDefined();
  });
});
