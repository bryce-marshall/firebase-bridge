import { FirebaseCloudStorageService } from '../index.js';

describe('FirebaseCloudStorageService adapter error mapping', () => {
  it('validates bucket ids before calling the provider', () => {
    const service = new FirebaseCloudStorageService(fakeStorage({}));

    expect(() => service.bucket('')).toThrow(
      expect.objectContaining({ code: 'storage/invalid-bucket' })
    );
    expect(() => service.bucket('bad/bucket')).toThrow(
      expect.objectContaining({ code: 'storage/invalid-bucket' })
    );
  });

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

  it('maps provider 412 errors to storage/precondition-failed', async () => {
    const service = new FirebaseCloudStorageService(
      fakeStorage({
        file: () =>
          fakeFile({
            save: async () => {
              throw { code: 412, message: 'precondition failed' };
            },
          }),
      })
    );

    await expect(
      service.bucket('errors.test').writeText('stale.txt', 'stale')
    ).rejects.toMatchObject({
      code: 'storage/precondition-failed',
    });
  });

  it('maps provider 500 and 503 errors to storage/unavailable', async () => {
    const unavailable = (statusCode: number) =>
      new FirebaseCloudStorageService(
        fakeStorage({
          file: () =>
            fakeFile({
              download: async () => {
                throw { statusCode, message: 'temporarily unavailable' };
              },
            }),
        })
      );

    await expect(
      unavailable(500).bucket('errors.test').read('unavailable.txt')
    ).rejects.toMatchObject({
      code: 'storage/unavailable',
    });
    await expect(
      unavailable(503).bucket('errors.test').read('unavailable.txt')
    ).rejects.toMatchObject({
      code: 'storage/unavailable',
    });
  });

  it('maps bucket-level 404 errors to storage/bucket-not-found', async () => {
    const service = new FirebaseCloudStorageService(
      fakeStorage({
        getFiles: async () => {
          throw { code: 404, message: 'bucket not found' };
        },
      })
    );

    await expect(service.bucket('missing.test').list()).rejects.toMatchObject({
      code: 'storage/bucket-not-found',
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

  it('does not sign missing objects with fake provider support', async () => {
    const getSignedUrl = jest.fn();
    const service = new FirebaseCloudStorageService(
      fakeStorage({
        file: () =>
          fakeFile({
            exists: async () => [false],
            getSignedUrl,
          }),
      })
    );

    await expect(
      service.bucket('signed.test').createSignedReadUrl('missing.txt', {
        expiresAt: new Date('2026-01-02T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'storage/object-not-found' });
    expect(getSignedUrl).not.toHaveBeenCalled();
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
