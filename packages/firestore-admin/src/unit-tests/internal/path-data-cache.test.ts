import {
  PathDataCache,
  PathType,
  parseRawPath,
} from '../../lib/_internal/path';

describe('Path Parser Tests', () => {
  const Cache = new PathDataCache();

  beforeEach(() => {
    Cache.flush();
  });

  it('filters invalid paths', () => {
    expect(Cache.pathData('', 'document')?.type).toBeUndefined();
    expect(Cache.pathData('', 'collection')?.type).toBeUndefined();
    expect(Cache.pathData('col1', 'root')?.type).toBeUndefined();
    expect(Cache.pathData('col1', 'document')?.type).toBeUndefined();
    expect(Cache.pathData('col1/doc1', 'root')?.type).toBeUndefined();
    expect(Cache.pathData('col1/doc1', 'collection')?.type).toBeUndefined();
  });

  it('does not filter valid paths', () => {
    expect(Cache.pathData('', 'root')?.type).toEqual<PathType>('root');
    expect(Cache.pathData('col1', 'collection')?.type).toEqual<PathType>(
      'collection'
    );
    expect(Cache.pathData('col1/doc1', 'document')?.type).toEqual<PathType>(
      'document'
    );
    expect(
      Cache.pathData('col1/doc1/col2', 'collection')?.type
    ).toEqual<PathType>('collection');
    expect(
      Cache.pathData('col1/doc1/col2/doc2', 'document')?.type
    ).toEqual<PathType>('document');
  });

  it('retrieves the correct PathData when no filter is specified', () => {
    expect(Cache.pathData('')?.type).toEqual<PathType>('root');
    expect(Cache.pathData('col1')?.type).toEqual<PathType>('collection');
    expect(Cache.pathData('col1/doc1')?.type).toEqual<PathType>('document');
    expect(Cache.pathData('col1/doc1/col2')?.type).toEqual<PathType>(
      'collection'
    );
    expect(Cache.pathData('col1/doc1/col2/doc2')?.type).toEqual<PathType>(
      'document'
    );
  });

  it('resolves the correct parent segments', () => {
    expect(Cache.pathData('', 'root')?.segments).toEqual([]);
    expect(Cache.pathData('col1', 'collection')?.segments).toEqual(['col1']);
    expect(Cache.pathData('col1/doc1', 'document')?.segments).toEqual([
      'col1',
      'doc1',
    ]);
    expect(Cache.pathData('col1/doc1/col2', 'collection')?.segments).toEqual([
      'col1',
      'doc1',
      'col2',
    ]);
    expect(Cache.pathData('col1/doc1/col2/doc2', 'document')?.segments).toEqual(
      ['col1', 'doc1', 'col2', 'doc2']
    );
  });

  it('resolves the correct parent path', () => {
    expect(Cache.pathData('', 'root')?.parentPath).toEqual('');
    expect(Cache.pathData('col1', 'collection')?.parentPath).toEqual('');
    expect(Cache.pathData('col1/doc1', 'document')?.parentPath).toEqual('col1');
    expect(Cache.pathData('col1/doc1/col2', 'collection')?.parentPath).toEqual(
      'col1/doc1'
    );
    expect(
      Cache.pathData('col1/doc1/col2/doc2', 'document')?.parentPath
    ).toEqual('col1/doc1/col2');
  });

  it('resolves the correct id', () => {
    expect(Cache.pathData('', 'root')?.id).toEqual('');
    expect(Cache.pathData('col1', 'collection')?.id).toEqual('col1');
    expect(Cache.pathData('col1/doc1', 'document')?.id).toEqual('doc1');
    expect(Cache.pathData('col1/doc1/col2', 'collection')?.id).toEqual('col2');
    expect(Cache.pathData('col1/doc1/col2/doc2', 'document')?.id).toEqual(
      'doc2'
    );
  });

  it('resolves parent PathData', () => {
    const initialPath = 'col1/doc1/col2/doc2';
    const segments = parseRawPath(initialPath);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    let pathData = Cache.pathData(initialPath)!;
    function expectPathData(type: PathType, path: string): void {
      expect(pathData).toBeDefined();
      expect(pathData.type).toEqual(type);
      expect(pathData.path).toEqual(path);
      expect(pathData.segments).toEqual(segments);
      segments.pop();
      pathData = pathData.parent();
    }
    expectPathData('document', 'col1/doc1/col2/doc2');
    expectPathData('collection', 'col1/doc1/col2');
    expectPathData('document', 'col1/doc1');
    expectPathData('collection', 'col1');
    expectPathData('root', '');
    // Repeated invocations of `parent()` on an empty path should return an empty `PathData`
    expectPathData('root', '');
    expectPathData('root', '');
  });

  it('returns cached data when present', () => {
    function expectRefEquality(path: string): void {
      const v1 = Cache.pathData(path);
      const v2 = Cache.pathData(path);
      expect(v1).toBeDefined();
      expect(v2).toBeDefined();
      expect(v1).toBe(v2);
    }

    expectRefEquality('');
    expectRefEquality('col1');
    expectRefEquality('col1/doc1');
    expectRefEquality('col1/doc1/col2');
    expectRefEquality('col1/doc1/col2/doc2');
  });

  it('parent() returns cached data when present', () => {
    function expectParentRefEquality(path: string): void {
      if (path === '') return;
      const current = Cache.assert(path);
      const parent = Cache.assert(current.parentPath);
      expect(current.parent()).toBe(parent);
      expectParentRefEquality(parent.path);
    }

    Cache.assert('');
    Cache.assert('col1');
    Cache.assert('col1/doc1');
    Cache.assert('col1/doc1/col2');
    Cache.assert('col1/doc1/col2/doc2');

    expectParentRefEquality('col1/doc1/col2/doc2');
  });
});
