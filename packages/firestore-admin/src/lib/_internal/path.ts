import { Status } from 'google-gax';
import { googleError } from './functions/google-error.js';

/**
 * Represents the type of a segment in a path.
 * - `'literal'`: a static path part (e.g., "users")
 * - `'param'`: a dynamic path parameter (e.g., "{userId}")
 */
export type PathPartType = 'literal' | 'param';

export type PathType = 'root' | 'collection' | 'document';

export interface PathDataProvider {
  /**
   * Returns a `PathData` instance
   */
  pathData(path: string, ...guards: PathType[]): PathData | undefined;
}

/**
 * An immutable instance containing both the fully qualified path and an immutable
 * array of path items
 */
export interface PathData extends PathDataProvider {
  /**
   * The path type, one of `'root' | 'collection' | 'document'`.
   */
  readonly type: PathType;
  /**
   * The fully qualified path to the parent of the node represente by this instance.
   */
  readonly parentPath: string;
  /**
   * The id of the resource associated with the path (the name for collection paths).
   * An empty string if the path is empty.
   */
  readonly id: string;
  /**
   * The full qualified path represented by this instance.
   */
  readonly path: string;
  /**
   * An immutable array of strings containing the individual segments of the path represented
   * by this instance.
   */
  readonly segments: readonly string[];
  /**
   * An immutable instance containing both the fully qualified path and an immutable
   * array of path items.
   */
  parent(): PathData;
}

export class PathDataCache implements PathDataProvider {
  private _data = new Map<string, PathData>();

  pathData(path: string, ...guards: PathType[]): PathData | undefined {
    let result = this._data.get(path);
    if (result == undefined) {
      const segments = parseRawPath(path);
      if (evalPathGuard(segments, guards)) {
        result = pathData(this, path, segments);
        this._data.set(path, result);
      }
    } else if (!evalPathGuard(result.segments, guards)) {
      result = undefined;
    }

    return result;
  }

  assert(path: string, ...guards: PathType[]): PathData {
    const result = this.pathData(path, ...guards);
    if (!result) {
      const type = pathType(path);
      const expectedType: PathType =
        type === 'collection' ? 'document' : 'collection';
      throw googleError(
        Status.INVALID_ARGUMENT,
        `Value for argument "path" must point to a ${expectedType}, but was "${path}".`
      );
    }

    return result;
  }

  flush(): void {
    this._data.clear();
  }
}

function evalPathGuard(
  segments: string[] | readonly string[],
  guards: PathType[]
): boolean {
  return guards.length === 0 || guards.indexOf(pathType(segments)) >= 0;
}

function pathData(
  owner: PathDataCache,
  path: string,
  segments: string[]
): PathData {
  const last = segments.length - 1;
  const data = Object.freeze<PathData>({
    type: pathType(segments),
    path,
    parentPath: last > 0 ? segments.slice(0, last).join('/') : '',
    id: last >= 0 ? segments[last] : '',
    segments: Object.freeze<readonly string[]>(segments),
    parent,
    pathData,
  });

  function parent(): PathData {
    if (data.path.length === 0) return data;

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return owner.pathData(data.parentPath)!;
  }
  function pathData(path: string, ...guards: PathType[]): PathData | undefined {
    return owner.pathData(
      data.path.length > 0 ? `${data.path}/${path}` : path,
      ...guards
    );
  }

  return data;
}

/**
 * Represents a segment of a parsed path, either static or dynamic.
 * This is an abstract base class and should not be instantiated directly.
 */
export abstract class PathPart {
  /**
   * The type of the path part: either `'literal'` or `'param'`.
   */
  abstract readonly type: PathPartType;

  /**
   * The original string value of the path part.
   */
  readonly value: string;

  /**
   * Constructs a path part with the given value.
   * @param value The raw string value of the path part.
   */
  constructor(value: string) {
    this.value = value;
  }
}

/**
 * Represents a static (literal) segment in a document path.
 * For example, in `users/{userId}`, the segment `users` is literal.
 */
export class LiteralPathPart extends PathPart {
  /** The type of the path part — always `'literal'`. */
  override readonly type: PathPartType = 'literal';
}

/**
 * Represents a dynamic (parameterized) segment in a document path.
 * For example, in `users/{userId}`, the segment `{userId}` is a parameter.
 */
export class ParamPathPart extends PathPart {
  /** The type of the path part — always `'param'`. */
  override readonly type: PathPartType = 'param';
  /**
   * The name of the parameter (e.g., `"userId"` in `{userId}`).
   */
  readonly name: string;

  /**
   * Constructs a parameter path part with the given name and value.
   * @param name The name of the path parameter.
   * @param value The raw value matched in the actual path.
   */
  constructor(name: string, value: string) {
    super(value);
    this.name = name;
  }
}

export function parseRawPath(path: string): string[] {
  if (path.length === 0) return [];

  return path.split('/');
}

export function joinPathParts(path: string[]): string {
  return path.join('/');
}

export function pathType(
  pathParts: string[] | readonly string[] | string
): PathType {
  if (typeof pathParts === 'string') pathParts = parseRawPath(pathParts);

  return pathParts.length % 2 === 1
    ? 'collection'
    : pathParts.length === 0
    ? 'root'
    : 'document';
}

const PARAM_REGEX = /^\{([a-zA-Z_][a-zA-Z0-9_]*)\}$/;

/**
 * Matches a Firestore-style path pattern against an actual path.
 *
 * @param pattern A Firestore-style pattern (e.g. 'users/{userId}/posts/{postId}')
 * @param path An actual document path (e.g. 'users/abc/posts/123')
 * @returns An array of `LiteralPathPart` and `ParamPathPart` if the path matches the pattern;
 *          otherwise `undefined`
 */
export function matchFirestorePath(
  pattern: string,
  path: string
): (LiteralPathPart | ParamPathPart)[] | undefined {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = path.split('/').filter(Boolean);

  if (patternSegments.length !== pathSegments.length) {
    return undefined;
  }

  const result: (LiteralPathPart | ParamPathPart)[] = [];

  for (let i = 0; i < patternSegments.length; i++) {
    const patternSegment = patternSegments[i];
    const pathSegment = pathSegments[i];

    const match = PARAM_REGEX.exec(patternSegment);
    if (match) {
      const paramName = match[1];
      result.push(new ParamPathPart(paramName, pathSegment));
    } else if (patternSegment === pathSegment) {
      result.push(new LiteralPathPart(pathSegment));
    } else {
      return undefined;
    }
  }

  return result;
}
