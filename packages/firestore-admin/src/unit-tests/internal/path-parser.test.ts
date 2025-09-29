import { pathType, PathType } from '../../lib/_internal/path';

describe('Path Parser Tests', () => {
  it('resolves the expected path type', async () => {
    expect(pathType([])).toEqual<PathType>('root');
    expect(pathType(['col1'])).toEqual<PathType>('collection');
    expect(pathType(['col1', 'doc1', 'col2'])).toEqual<PathType>('collection');
    expect(pathType(['col1', 'doc1'])).toEqual<PathType>('document');
    expect(pathType(['col1', 'doc1', 'col2', 'doc1'])).toEqual<PathType>(
      'document'
    );
  });
});
