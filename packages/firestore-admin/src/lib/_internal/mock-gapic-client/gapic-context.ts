import { google } from '@gcf/firestore-protos';
import { Firestore } from 'firebase-admin/firestore';
import { Status } from 'google-gax';
import { DataAccessor, MetaDocument } from '../data-accessor.js';
import { DatabasePool } from '../database-pool.js';
import { DEFAULT_DATABASE_ID } from '../firestore/constants.js';
import { getSerializer, Serializer } from '../firestore/serializer.js';
import { ToProto, WithFirestoreSettings } from '../firestore/typecast.js';
import { googleError } from '../functions/google-error.js';
import { DEFAULT_PROJECT_ID } from '../internal-types.js';
import { pathType } from '../path.js';
import { assertValidProjectId } from './utils/assert.js';
import { parseFieldPath } from '../functions/util.js';

/**
 * Context helper for GAPIC-shaped operations backed by the in-memory DataAccessor.
 *
 * @remarks
 * - Resolves `projectId` / `databaseId` from the Admin SDK `Firestore` instance
 *   (falling back to {@link DEFAULT_PROJECT_ID} / {@link DEFAULT_DATABASE_ID}).
 * - Provides path conversion between Admin SDK internal paths (e.g. `users/u1`)
 *   and GAPIC resource names (e.g. `projects/{p}/databases/{d}/documents/users/u1`).
 * - Surfaces a {@link Serializer} consistent with the Admin SDK to produce
 *   wire-compatible `google.firestore.v1.Document` payloads.
 */
export class GapicContext {
  /** Project ID used for resource names. */
  readonly projectId: string;
  /** Database ID (usually `'(default)'`). */
  readonly databaseId: string;
  /** Admin SDK serializer used for encode/decode of Firestore values. */
  readonly serializer: Serializer;
  /** GAPIC resource root: `projects/{project}/databases/{database}/documents`. */
  readonly gapicRoot: string;

  /**
   * Creates a GAPIC context bound to a Firestore instance and a database pool.
   *
   * @param firestore - The Admin SDK `Firestore` whose settings define project/database.
   * @param _pool - Backing {@link DatabasePool} from which `DataAccessor` instances are resolved.
   *
   * @throws {GoogleError} If the `projectId` is invalid (via {@link assertValidProjectId}).
   */
  constructor(firestore: Firestore, private readonly _pool: DatabasePool) {
    this.projectId = assertValidProjectId(
      (firestore as unknown as WithFirestoreSettings)._settings?.projectId ??
        DEFAULT_PROJECT_ID
    );
    this.databaseId =
      (firestore as unknown as WithFirestoreSettings)._settings?.databaseId ??
      DEFAULT_DATABASE_ID;
    this.serializer = getSerializer(firestore);
    this.gapicRoot = `projects/${this.projectId}/databases/${this.databaseId}/documents`;
  }

  /**
   * Returns whether a `DataAccessor` exists for the bound project/database.
   */
  hasAccessor(): boolean {
    return this._pool.exists(this.projectId, this.databaseId);
  }

  /**
   * Retrieves the {@link DataAccessor} for the bound project/database.
   *
   * @returns The accessor associated with this context.
   * @throws {Error} If no accessor exists for the pair (asserted by the pool).
   */
  getAccessor(): DataAccessor {
    return this._pool.getWithAssert(this.projectId, this.databaseId).accessor;
  }

  /**
   * Converts an Admin-style internal path to a GAPIC resource name.
   *
   * @param internalPath - Path like `''` (root), `users/u1`, or `users/u1/posts/p1`.
   * @returns A GAPIC resource: either `gapicRoot` for `''`, or `gapicRoot/{internalPath}`.
   * @throws {GoogleError} If `internalPath` fails validation.
   *
   * @remarks
   * Validation is performed by {@link validateInternalPath}.
   */
  toGapicPath(internalPath: string): string {
    validateInternalPath(internalPath);

    return internalPath ? `${this.gapicRoot}/${internalPath}` : this.gapicRoot;
  }

  /**
   * Builds a collection path by appending a collection ID to a parent path.
   *
   * @param parentPath - Parent internal path (document or root).
   * @param id - Collection ID to append.
   * @returns The combined **internal** collection path.
   */
  collectionPath(parentPath: string, id: string): string {
    return this.toInternalPath(`${parentPath}/${id}`, 'collection');
  }

  /**
   * Converts a GAPIC resource name to an Admin-style internal path with type checking.
   *
   * @param gapicPath - Full resource path starting with {@link gapicRoot}.
   * @param guard - Expected path kind for the returned internal path (`'collection' | 'document'`).
   * @returns The internal path with the root prefix stripped.
   *
   * @throws {GoogleError}
   * - `INVALID_ARGUMENT` if `gapicPath` is missing, has a mismatched prefix, fails validation,
   *   or does not match the `guard` (except that `'root'` is allowed when `guard === 'document'`).
   *
   * @remarks
   * Uses {@link pathType} to enforce the requested guard.
   */
  toInternalPath(
    gapicPath: string | null | undefined,
    guard: 'collection' | 'document'
  ): string {
    let internalPath: string;
    if (!gapicPath)
      throw googleError(Status.INVALID_ARGUMENT, 'Missing resource name.');

    if (!gapicPath.startsWith(this.gapicRoot)) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `Resource path does not match project/database: expected prefix "${this.gapicRoot}", got "${gapicPath}".`
      );
    }

    // Remove the prefix and leading slash
    internalPath = gapicPath.substring(this.gapicRoot.length);
    if (internalPath.startsWith('/')) {
      internalPath = internalPath.slice(1);
    }
    validateInternalPath(internalPath);

    const type = pathType(internalPath);
    if (guard !== type && !(type === 'root' && guard === 'document')) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        `The ${guard} resource name is invalid.`
      );
    }

    return internalPath;
  }

  /**
   * Serializes a meta-document to a `google.firestore.v1.Document`, optionally applying a field mask.
   *
   * @param doc - The source {@link MetaDocument}.
   * @param fieldMask - Optional list of field paths to include (Admin SDK semantics).
   * @returns A `google.firestore.v1.IDocument` with `name`, `fields`, `createTime`, and `updateTime`.
   *
   * @remarks
   * - `name` is built via {@link toGapicPath}.
   * - `fields` are encoded using the Admin SDK {@link Serializer}; when `fieldMask` is provided,
   *   encoding is filtered by {@link applyFieldMask}.
   * - `createTime` / `updateTime` are sourced from the meta and converted via `ToProto#toProto()`.
   */
  serializeDoc(
    doc: MetaDocument,
    fieldMask?: string[]
  ): google.firestore.v1.IDocument {
    const name = this.toGapicPath(doc.path);
    const encoded: FieldsDict | undefined = doc.data
      ? (this.serializer.encodeFields(doc.data) as FieldsDict)
      : undefined;

    return {
      name,
      fields: fieldMask ? applyFieldMask(encoded, fieldMask) : encoded,
      createTime: (doc.createTime as ToProto | undefined)?.toProto()
        .timestampValue,
      updateTime: (doc.updateTime as unknown as ToProto | undefined)?.toProto()
        .timestampValue,
    };
  }
}

/**
 * Validates a Firestore resource path relative to the `/documents` root.
 *
 * @param path The path portion after `/documents`. May be "" for the root.
 * @throws {GoogleError} If the path violates Firestore's path constraints.
 */
function validateInternalPath(path: string): void {
  function fail(): void {
    throw googleError(
      Status.INVALID_ARGUMENT,
      `Invalid resource path "${path}".`
    );
  }
  // Regex:
  // - "" is allowed (root)
  // - segments are non-empty, no "/" or control chars
  // - cannot be "." or ".."
  // - cannot match "__.*__" (reserved)
  const PATH_RE =
    /^(?:$|(?!(?:\.{1,2}|__[^/]*__))[^/\p{Cc}]+(?:\/(?!(?:\.{1,2}|__[^/]*__))[^/\p{Cc}]+)*)$/u;

  if (!PATH_RE.test(path)) {
    fail();
  }

  const MAX_SEGMENT_LENGTH = 1500;
  // Check per-segment UTF-8 byte length ≤ 1,500
  for (const segment of path === '' ? [] : path.split('/')) {
    const byteLength = new TextEncoder().encode(segment).length;
    if (byteLength > MAX_SEGMENT_LENGTH) {
      fail();
    }
  }
}

// Convenience alias for readability
type FieldsDict = Record<string, google.firestore.v1.IValue>;

function normalizeMask(mask: string[]): string[] {
  // 1) remove the reserved __name__ path
  // 2) dedupe
  // 3) prune child paths when a parent is present
  const filtered = Array.from(new Set(mask.filter((p) => p !== '__name__')));
  filtered.sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const p of filtered) {
    const hasAncestor = kept.some(
      (parent) => p === parent || p.startsWith(parent + '.')
    );
    if (!hasAncestor) kept.push(p);
  }
  return kept;
}

function applyFieldMask(
  fields: FieldsDict | undefined | null,
  mask: string[]
): FieldsDict | undefined {
  const realMask = normalizeMask(mask);
  const root: FieldsDict | undefined = fields ?? undefined; // strip null → undefined

  if (!root || realMask.length === 0) {
    // - no stored fields, or
    // - mask had only __name__ (name-only projection)
    return undefined;
  }

  const result: FieldsDict = {};

  for (const path of realMask) {
    const segments = parseFieldPath(path);
    const leafKey = segments.pop();
    if (!leafKey) continue;

    // Walk source tree to the parent of the leaf
    let source: FieldsDict | undefined = root;
    for (const segment of segments) {
      const nested = source?.[segment];
      const nestedFields = nested?.mapValue?.fields as FieldsDict | undefined;
      if (!nestedFields) {
        source = undefined; // path missing in source
        break;
      }
      source = nestedFields;
    }

    const leaf = source?.[leafKey];
    if (leaf !== undefined) {
      // Mirror path on result and assign leaf
      let target: FieldsDict = result;
      for (const segment of segments) {
        const existing = target[segment]?.mapValue?.fields as
          | FieldsDict
          | undefined;
        if (existing) {
          target = existing;
        } else {
          const fields: FieldsDict = {};
          target[segment] = { mapValue: { fields } };
          target = fields;
        }
      }
      target[leafKey] = leaf;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
