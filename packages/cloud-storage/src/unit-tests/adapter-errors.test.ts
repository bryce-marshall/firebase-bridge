import { FirebaseCloudStorageService } from '../index.js';

describe('FirebaseCloudStorageService adapter error mapping', () => {
  it('maps provider 403 errors to storage/permission-denied', async () => {
    const service = new FirebaseCloudStorageService(
      fakeStorage({
        file: () =>
          fakeFile({
            download: async () => {
              throw { code: 403, message: 'denied' };
            },
          }),
      })
    );

    await expect(service.bucket('errors.test').read('denied.txt')).rejects.toMatchObject({
      code: 'storage/permission-denied',
    });
  });

  it('maps unknown provider errors to storage/unknown', async () => {
    const service = new FirebaseCloudStorageService(
      fakeStorage({
        getFiles: async () => {
          throw new Error('unexpected provider failure');
        },
      })
    );

    await expect(service.bucket('errors.test').list()).rejects.toMatchObject({
      code: 'storage/unknown',
    });
  });

  it('creates signed read URLs with fake provider support', async () => {
    const expiresAt = new Date('2026-01-02T00:00:00.000Z');
    const getSignedUrl = jest
      .fn()
      .mockResolvedValue(['https://signed.example.test/object']);
    const service = new FirebaseCloudStorageService(
      fakeStorage({
        file: () =>
          fakeFile({
            exists: async () => [true],
            getSignedUrl,
          }),
      })
    );

    await expect(
      service.bucket('signed.test').createSignedReadUrl('file.txt', { expiresAt })
    ).resolves.toEqual({
      url: 'https://signed.example.test/object',
      expiresAt,
    });
    expect(getSignedUrl).toHaveBeenCalledWith({
      action: 'read',
      expires: expiresAt,
    });
  });
});

function fakeStorage(bucketOverrides: Record<string, unknown>) {
  return {
    bucket(name?: string) {
      return {
        name: name ?? 'default.test',
        file: () => fakeFile(),
        getFiles: async () => [[], undefined, undefined],
        ...bucketOverrides,
      };
    },
  } as never;
}

function fakeFile(overrides: Record<string, unknown> = {}) {
  return {
    name: 'file.txt',
    exists: async () => [true],
    download: async () => [Buffer.from('data')],
    save: async () => undefined,
    delete: async () => undefined,
    getMetadata: async () => [
      {
        bucket: 'errors.test',
        name: 'file.txt',
        size: 4,
        generation: '1',
        metageneration: '1',
        timeCreated: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
      },
    ],
    setMetadata: async () => [
      {
        bucket: 'errors.test',
        name: 'file.txt',
        size: 4,
        generation: '1',
        metageneration: '2',
        timeCreated: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:01.000Z',
      },
    ],
    getSignedUrl: async () => ['https://signed.example.test/object'],
    ...overrides,
  };
}
