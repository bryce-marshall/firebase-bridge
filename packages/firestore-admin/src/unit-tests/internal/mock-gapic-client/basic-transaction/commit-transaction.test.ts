import { Status } from 'google-gax';
import { ExpectError } from '../../../common';
import { MockGapicTestContext, mockGapicTestContext } from '../test-utils';

describe('MockGapicClient.commit', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  describe('Basic Write Operations', () => {
    it('writes a set operation', async () => {
      const localPath = 'users/user1';
      const path = Mock.context.toGapicPath(localPath);
      const doc = { name: 'Alice', age: 30 };

      await Mock.client.commit({
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields(doc),
            },
          },
        ],
      });
      const stored = Mock.db.getDocument(localPath);
      expect(stored.data?.name).toBe('Alice');
      expect(stored.data?.age).toBe(30);
    });

    it('writes an update operation', async () => {
      const localPath = 'users/user2';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { name: 'Bob', age: 40 });

      await Mock.client.commit({
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({ age: 41 }),
            },
            updateMask: { fieldPaths: ['age'] },
          },
        ],
      });

      const updated = Mock.db.getDocument(localPath);
      expect(updated.data?.name).toBe('Bob');
      expect(updated.data?.age).toBe(41);
    });

    it('writes a delete operation', async () => {
      const localPath = 'users/user3';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { temp: true });
      expect(Mock.db.getDocument(localPath).exists).toBe(true);

      await Mock.client.commit({ writes: [{ delete: path }] });

      expect(Mock.db.getDocument(localPath).exists).toBe(false);
    });

    it('returns valid response with no writes', async () => {
      const [res] = await Mock.client.commit({ writes: [] });
      expect(res.commitTime).toBeDefined();
      expect(res.writeResults).toHaveLength(0);
    });
  });

  describe('Preconditions', () => {
    it('fails update with exists: false', async () => {
      const localPath = 'users/missing';
      const path = Mock.context.toGapicPath(localPath);

      await ExpectError.async(
        () =>
          Mock.client.commit({
            writes: [
              {
                update: {
                  name: path,
                  fields: Mock.context.serializer.encodeFields({}),
                },
                currentDocument: { exists: true },
              },
            ],
          }),
        ExpectError.status(Status.NOT_FOUND)
      );
    });

    it('succeeds delete with exists: true when doc exists', async () => {
      const localPath = 'users/user4';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { name: 'X' });

      await expect(
        Mock.client.commit({
          writes: [
            {
              delete: path,
              currentDocument: { exists: true },
            },
          ],
        })
      ).resolves.toBeDefined();
    });
  });

  describe('Transforms', () => {
    it('applies serverTimestamp transform', async () => {
      const localPath = 'users/user5';
      const path = Mock.context.toGapicPath(localPath);
      const [res] = await Mock.client.commit({
        writes: [
          {
            update: {
              name: path,
              fields: {},
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
      expect(doc.data?.lastLogin).toBeDefined();
      const value =
        res.writeResults?.[0]?.transformResults?.[0]?.timestampValue;
      expect(value).toEqual(res.commitTime);
    });
  });

  describe('Return Structure', () => {
    it('commitTime is included', async () => {
      const [res] = await Mock.client.commit({ writes: [] });
      expect(res.commitTime).toBeDefined();
    });
    it('writeResults match input count', async () => {
      const path1 = Mock.context.toGapicPath('users/user6');
      const path2 = Mock.context.toGapicPath('users/user6b');

      const [res] = await Mock.client.commit({
        writes: [
          {
            update: {
              name: path1,
              fields: Mock.context.serializer.encodeFields({ a: 1 }),
            },
          },
          { delete: path2 },
        ],
      });
      expect(res.writeResults).toHaveLength(2);
    });
  });
});
