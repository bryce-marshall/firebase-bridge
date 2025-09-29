import { FieldValue } from 'firebase-admin/firestore';
import { mockGapicTestContext, MockGapicTestContext } from '../test-utils';

describe('MockGapicClient.commit with field delete', () => {
  let Mock!: MockGapicTestContext;

  beforeEach(() => {
    Mock = mockGapicTestContext({ database: 'TestDB' });
  });

  describe('Field Deletion', () => {
    it('deletes a field using updateMask', async () => {
      const localPath = 'users/user7';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { name: 'Eve', temp: true });

      await Mock.client.commit({
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({
                temp: FieldValue.delete(),
              }),
            },
            updateMask: { fieldPaths: ['temp'] },
          },
        ],
      });

      const doc = Mock.db.getDocument(localPath);
      expect(doc.data).toEqual({ name: 'Eve' });
    });

    it('deletes multiple fields using updateMask', async () => {
      const localPath = 'users/user8';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { a: 1, b: 2, c: 3 });

      await Mock.client.commit({
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({
                a: FieldValue.delete(),
                b: FieldValue.delete(),
              }),
            },
            updateMask: { fieldPaths: ['a', 'b'] },
          },
        ],
      });

      const doc = Mock.db.getDocument(localPath);
      expect(doc.data).toEqual({ c: 3 });
    });

    it('deletes a field via set with merge = true', async () => {
      const localPath = 'users/user9';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { profile: { age: 25, temp: 'remove' } });

      await Mock.client.commit({
        writes: [
          {
            update: {
              name: path,
              fields: Mock.context.serializer.encodeFields({
                profile: { temp: FieldValue.delete() },
              }),
            },
            updateMask: { fieldPaths: ['profile.temp'] },
          },
        ],
      });

      const doc = Mock.db.getDocument(localPath);
      expect(doc.data).toEqual({ profile: { age: 25 } });
    });

    it('does not throw if deleting a non-existent field', async () => {
      const localPath = 'users/user10';
      const path = Mock.context.toGapicPath(localPath);
      Mock.db.setDocument(localPath, { foo: 'bar' });

      await expect(
        Mock.client.commit({
          writes: [
            {
              update: {
                name: path,
                fields: Mock.context.serializer.encodeFields({
                  missing: FieldValue.delete(),
                }),
              },
              updateMask: { fieldPaths: ['missing'] },
            },
          ],
        })
      ).resolves.toBeDefined();

      const doc = Mock.db.getDocument(localPath);
      expect(doc.data).toEqual({ foo: 'bar' });
    });
  });
});
