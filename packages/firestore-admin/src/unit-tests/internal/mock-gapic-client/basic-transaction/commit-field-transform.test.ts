import { Timestamp } from 'firebase-admin/firestore';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';

describe('MockGapicClient.commit > transforms', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  it('applies serverTimestamp transform on empty document', async () => {
    const localPath = 'users/user-tx1';
    const gapicPath = Mock.context.toGapicPath(localPath);

    const [res] = await Mock.client.commit({
      writes: [
        {
          update: {
            name: gapicPath,
            fields: {}, // empty object to simulate transform-only write
          },
          updateTransforms: [
            {
              fieldPath: 'lastLogin',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
        },
      ],
    });

    const doc = Mock.db.getDocument(localPath);
    expect(doc.exists).toBe(true);
    expect(doc.data?.lastLogin).toBeInstanceOf(Timestamp);

    const transformValue =
      res.writeResults?.[0]?.transformResults?.[0].timestampValue;
    expect(transformValue).toEqual(res.commitTime);
  });

  it('applies multiple transforms in a single write', async () => {
    const path = 'users/user-tx2';
    const name = Mock.context.toGapicPath(path);

    const [res] = await Mock.client.commit({
      writes: [
        {
          update: { name, fields: {} },
          updateTransforms: [
            { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
            { fieldPath: 'lastLogin', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ],
    });

    const doc = Mock.db.getDocument(path);
    expect(doc.exists).toBe(true);
    expect(doc.data?.createdAt).toBeInstanceOf(Timestamp);
    expect(doc.data?.lastLogin).toBeInstanceOf(Timestamp);

    const results = res.writeResults?.[0]?.transformResults;
    expect(results?.length).toBe(2);
    expect(results?.[0]?.timestampValue).toEqual(res.commitTime);
    expect(results?.[1]?.timestampValue).toEqual(res.commitTime);
  });

  it('applies transform to nested field', async () => {
    const path = 'users/user-tx3';
    const name = Mock.context.toGapicPath(path);

    const [res] = await Mock.client.commit({
      writes: [
        {
          update: { name, fields: {} },
          updateTransforms: [
            {
              fieldPath: 'profile.timestamps.lastSeen',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
        },
      ],
    });

    const doc = Mock.db.getDocument(path);
    expect(doc.exists).toBe(true);
    const nested = doc.data?.profile?.timestamps?.lastSeen;
    expect(nested).toBeInstanceOf(Timestamp);

    const transformValue =
      res.writeResults?.[0]?.transformResults?.[0]?.timestampValue;
    expect(transformValue).toEqual(res.commitTime);
  });

  it('applies transform alongside static field values', async () => {
    const path = 'users/user-tx4';
    const name = Mock.context.toGapicPath(path);
    const encoder = Mock.context.serializer;

    const [res] = await Mock.client.commit({
      writes: [
        {
          update: {
            name,
            fields: {
              // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
              role: encoder.encodeValue('admin')!,
            },
          },
          updateTransforms: [
            { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' },
          ],
        },
      ],
    });

    const doc = Mock.db.getDocument(path);
    expect(doc.exists).toBe(true);
    expect(doc.data?.role).toBe('admin');
    expect(doc.data?.updatedAt).toBeInstanceOf(Timestamp);

    const transformValue =
      res.writeResults?.[0]?.transformResults?.[0]?.timestampValue;
    expect(transformValue).toEqual(res.commitTime);
  });

  it('rejects delete + transform in same write', async () => {
    const path = 'users/user-tx5';
    const name = Mock.context.toGapicPath(path);

    await expect(
      Mock.client.commit({
        writes: [
          {
            delete: name,
            updateTransforms: [
              {
                fieldPath: 'deletedAt',
                setToServerValue: 'REQUEST_TIME',
              },
            ],
          },
        ],
      })
    ).rejects.toMatchObject({
      code: 3, // INVALID_ARGUMENT
    });
  });
});
