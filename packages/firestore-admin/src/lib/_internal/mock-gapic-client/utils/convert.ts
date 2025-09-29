import type { google } from '@gcf/firestore-protos';
import {
  DocumentData,
  Precondition,
  Timestamp,
} from 'firebase-admin/firestore';
import { GoogleError, Status } from 'google-gax';
import {
  DocumentFieldTransformer,
  MergeGranularity,
  NormalizedWrite,
} from '../../data-accessor.js';
import { Serializer } from '../../firestore/serializer.js';
import { TimestampFromProto } from '../../firestore/typecast.js';
import { googleError } from '../../functions/google-error.js';
import { parseFieldPath } from '../../functions/util.js';
import { GapicContext } from '../gapic-context.js';
import { compareValues } from './compare-values.js';
import { getDeepValue, setDeepValue } from './deep-value.js';

/**
 * Result of normalizing and transforming a single GAPIC Write.
 *
 * - `normalized` is the internal write shape that the mock/engine understands.
 * - `transformResults` (when present) contains encoded proto `Value`s produced
 *   by field transforms, in the same order as the request’s transforms. These
 *   are later surfaced as `WriteResult.transformResults`.
 */
export interface TransformedWrite {
  normalized: NormalizedWrite;
  transformResults?: google.firestore.v1.IValue[] | null;
}

/**
 * Converts an array of GAPIC `Write` messages into normalized internal writes,
 * applying Firestore Admin SDK semantics and preparing transform results.
 *
 * Supported operations:
 * - **Delete** (`write.delete`): cannot be combined with `update` or transforms.
 * - **Update/Set** (`write.update`) with optional `updateMask` and
 *   `updateTransforms`:
 *   - Decodes `update.fields` into POJO data.
 *   - When an `updateMask` is present:
 *     - Builds a sparse object containing only masked fields.
 *     - For fields listed in the mask but missing from `update.fields`, inserts
 *       a deletion sentinel (implemented as a thunk) to mark field deletion.
 *     - Sets merge granularity to:
 *       - `'node'` if any masked path is nested (multi-segment),
 *       - otherwise `'branch'` (top-level only).
 *   - Without `updateMask`, the operation is treated as a full-document set with
 *     merge granularity `'root'`.
 *   - `updateTransforms` are converted to {@link DocumentFieldTransformer}s and
 *     written into the outgoing data at their respective field paths. Any values
 *     they produce are appended to `transformResults` (proto-encoded).
 *
 * Validation & errors:
 * - `write.transform` (top-level transform-only writes) are **not supported**
 *   by the Admin SDK: throws `INVALID_ARGUMENT`.
 * - A write specifying `delete` **and** `update`/**transforms** is invalid:
 *   throws `INVALID_ARGUMENT`.
 * - A write that specifies none of `update`, `delete`, or transforms: throws
 *   `INVALID_ARGUMENT`.
 * - Nested arrays (an array directly containing an array) are rejected to mirror
 *   Firestore’s error: throws `INVALID_ARGUMENT`.
 * - Field transform kinds outside the supported set result in `UNIMPLEMENTED`.
 *
 * @param context - GAPIC context with serializer and path conversion.
 * @param writes - Array of GAPIC `IWrite` messages.
 * @returns Array of {@link TransformedWrite} in request order.
 */
export function transformWrites(
  context: GapicContext,
  writes: google.firestore.v1.IWrite[]
): TransformedWrite[] {
  const result: TransformedWrite[] = [];

  for (const write of writes) {
    // === INVALID: transform-only writes are unsupported in Admin SDK ===
    if (write.transform) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'The `transform` field in Write is not supported by the Admin SDK.'
      );
    }

    const hasUpdate = !!write.update;
    const hasDelete = !!write.delete;
    const hasTransform = !!write.updateTransforms?.length;

    if (hasDelete && (hasUpdate || hasTransform)) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'A Write may not specify delete alongside update or transform.'
      );
    }

    if (!hasUpdate && !hasDelete && !hasTransform) {
      throw googleError(
        Status.INVALID_ARGUMENT,
        'Write must specify at least one of update, delete, or transform.'
      );
    }

    // === 1. DELETE ===
    if (write.delete) {
      result.push({
        normalized: {
          type: 'delete',
          path: context.toInternalPath(write.delete, 'document'),
          precondition: toPrecondition(write.currentDocument),
        },
      });
      continue;
    }

    // === 2. UPDATE / SET with optional updateTransforms ===
    if (write.update) {
      prevalidateNoArrayInArrayForFields(write.update.fields);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const docPath = write.update.name!;
      const allFields = decodeDocData(context.serializer, write.update.fields);
      let data = allFields;
      let merge: MergeGranularity = write.updateMask ? 'branch' : 'root';

      if (write.updateMask) {
        data = {};
        const fpaths = write.updateMask.fieldPaths ?? [];
        let anyNested = false;

        for (const fieldPath of fpaths) {
          const segments = parseFieldPath(fieldPath); // robust parser (handles escapes)
          if (segments.length > 1) anyNested = true;

          const val = getDeepValue(allFields, segments);
          if (val !== undefined) {
            setDeepValue(data, segments, val);
          } else {
            // Missing in fields + present in mask ⇒ deletion
            setDeepValue(data, segments, () => undefined);
          }
        }

        if (anyNested) merge = 'node';
        // else stays 'branch' (mask with only top-level fields)
      }

      const output: TransformedWrite = {
        normalized: {
          type: 'set',
          path: context.toInternalPath(docPath, 'document'),
          data,
          merge,
          precondition: toPrecondition(write.currentDocument),
        },
      };

      if (write.updateTransforms?.length) {
        for (const transform of write.updateTransforms) {
          const transformer = toFieldTransformer(
            context.serializer,
            transform,
            output
          );
          if (transformer) {
            const fieldPath = transform.fieldPath;
            if (!fieldPath) throw invalidFieldTransform();
            setDeepValue(data, fieldPath.split('.'), transformer);
          }
        }
      }

      result.push(output);
      continue;
    }

    throw googleError(Status.INVALID_ARGUMENT, 'Unsupported IWrite operation.');
  }

  return result;
}

/**
 * Helper that creates a standardized `GoogleError` for malformed field transforms.
 *
 * @returns A `GoogleError` with `INVALID_ARGUMENT`.
 * @internal
 */
function invalidFieldTransform(): GoogleError {
  return googleError(Status.INVALID_ARGUMENT, 'Invalid IField transform.');
}

/**
 * Decodes a `mapValue.fields` object into a `DocumentData` POJO using the serializer.
 *
 * @param serializer - Serializer able to decode proto `Value`s.
 * @param fields - The `mapValue.fields` bag to decode. `null`/`undefined` becomes `{}`.
 * @returns A decoded Firestore `DocumentData` object.
 */
function decodeDocData(
  serializer: Serializer,
  fields: Record<string, google.firestore.v1.IValue> | null | undefined
): DocumentData {
  return serializer.decodeValue({
    mapValue: { fields: fields ?? {} },
  }) as DocumentData;
}

/**
 * Validates that no arrays directly contain arrays (i.e., nested array values),
 * mirroring Firestore’s restriction and error wording.
 *
 * Recurses through arrays and maps and throws when an array element is itself
 * an array. Scalars are ignored.
 *
 * @param fields - Root `mapValue.fields` bag to validate. No-op when absent.
 * @throws {GoogleError} {@link Status.INVALID_ARGUMENT}
 *         with message "Cannot convert an array value in an array value."
 */
function prevalidateNoArrayInArrayForFields(
  fields: Record<string, google.firestore.v1.IValue> | null | undefined
): void {
  function walk(v: google.firestore.v1.IValue | null | undefined): void {
    if (!v) return;

    // Validate arrays: no element may be an array
    const arr = v.arrayValue?.values;
    if (arr) {
      for (const el of arr) {
        if (el?.arrayValue) {
          // Mirror Firestore's error and status
          throw googleError(
            Status.INVALID_ARGUMENT,
            'Cannot convert an array value in an array value.'
          );
        }
        // Recurse to validate arrays found deeper inside maps, etc.
        walk(el);
      }
    }

    // Recurse into maps to find any arrays within and validate them by the same rule
    const fields = v.mapValue?.fields;
    if (fields) {
      for (const child of Object.values(fields)) {
        walk(child);
      }
    }
    // All other scalar Value variants are irrelevant to this rule.
  }

  if (!fields) return;
  for (const v of Object.values(fields)) {
    walk(v);
  }
}

/**
 * Converts a GAPIC `Precondition` to an internal `Precondition`.
 *
 * Mapping:
 * - `updateTime` → `{ lastUpdateTime: Timestamp }`
 * - `exists`     → `{ exists: boolean }`
 * - Absent or unrecognized fields → `undefined`
 *
 * @param source - GAPIC precondition or `null`/`undefined`.
 * @returns Internal precondition or `undefined`.
 */
export function toPrecondition(
  source: google.firestore.v1.IPrecondition | null | undefined
): Precondition | undefined {
  if (!source) return undefined;

  if (source.updateTime) {
    return {
      lastUpdateTime: (Timestamp as unknown as TimestampFromProto).fromProto(
        source.updateTime
      ),
    };
  }

  if (source.exists !== undefined) {
    return { exists: !!source.exists };
  }

  return undefined;
}

/**
 * (Duplicate type preserved for compatibility in this module.)
 *
 * Result of normalizing and transforming a single GAPIC Write.
 */
export interface TransformedWrite {
  normalized: NormalizedWrite;
  transformResults?: google.firestore.v1.IValue[] | null;
}

/**
 * Converts a single `DocumentTransform.FieldTransform` into an executable
 * {@link DocumentFieldTransformer} and appends any produced values to the
 * provided {@link TransformedWrite}'s `transformResults`.
 *
 * Supported transform kinds:
 * - `setToServerValue: REQUEST_TIME` → writes server time
 * - `increment` → numeric add (treats non-number base as 0)
 * - `appendMissingElements` (arrayUnion) → appends values not already present
 *   (equality determined via {@link compareValues})
 * - `removeAllFromArray` (arrayRemove) → removes all matching values
 *
 * Notes:
 * - Each invocation encodes the resulting value to proto and pushes it onto
 *   `output.transformResults` maintaining request order.
 * - Unsupported kinds throw `UNIMPLEMENTED`.
 *
 * @param serializer - Serializer for decoding/encoding `Value`s.
 * @param field - The field transform to convert.
 * @param output - The accumulating write result to which transform results are appended.
 * @returns A field transformer function or `undefined` when nothing to apply.
 * @throws {GoogleError} {@link Status.UNIMPLEMENTED} for unsupported kinds.
 */
export function toFieldTransformer(
  serializer: Serializer,
  field: google.firestore.v1.DocumentTransform.IFieldTransform,
  output: TransformedWrite
): DocumentFieldTransformer | undefined {
  function append<T>(value: T): T {
    output.transformResults ??= [];
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    output.transformResults.push(serializer.encodeValue(value)!);

    return value;
  }

  if (field.setToServerValue === 'REQUEST_TIME') {
    return (ctx) => append(ctx.serverTime);
  }

  if (field.increment) {
    const incValue =
      (serializer.decodeValue(field.increment) as number | undefined) ?? 0;
    return (ctx) => {
      const base = typeof ctx.fieldValue === 'number' ? ctx.fieldValue : 0;

      return append(base + incValue);
    };
  }

  if (field.appendMissingElements) {
    const uniqueElems = decodeAndDedupeArray(
      serializer,
      field.appendMissingElements
    );

    return (ctx) => {
      const base: unknown[] = Array.isArray(ctx.fieldValue)
        ? ctx.fieldValue
        : [];

      const toAdd = uniqueElems.filter(
        (el) => !base.some((b) => compareValues(b, el) === 0)
      );

      return append([...base, ...toAdd]);
    };
  }

  if (field.removeAllFromArray) {
    const uniqueRemoves = decodeAndDedupeArray(
      serializer,
      field.removeAllFromArray
    );
    return (ctx) => {
      const base = Array.isArray(ctx.fieldValue) ? ctx.fieldValue : [];

      const out = base.filter(
        (b) => !uniqueRemoves.some((e) => compareValues(b, e) === 0)
      );

      return append(out);
    };
  }

  throw googleError(Status.UNIMPLEMENTED, 'Unsupported field transform.');
}

/**
 * Decodes a proto `ArrayValue` into an array of JS values using the serializer.
 *
 * @param serializer - Serializer capable of decoding proto `Value`.
 * @param av - The proto `ArrayValue` (may be null/undefined).
 * @returns A decoded array; empty when `av` is absent or has no `values`.
 */
function decodeArrayTransform(
  serializer: Serializer,
  av: google.firestore.v1.IArrayValue | null | undefined
): unknown[] {
  const values = av?.values ?? [];

  return values.map((v) =>
    serializer.decodeValue(v as google.firestore.v1.IValue)
  );
}

/**
 * Decodes a proto `ArrayValue` and de-duplicates elements using Firestore
 * equality (`compareValues`), preserving first occurrence order.
 *
 * @param serializer - Serializer for decoding.
 * @param value - The proto `ArrayValue` to decode and de-dupe.
 * @returns A de-duplicated array of decoded values.
 */
function decodeAndDedupeArray(
  serializer: Serializer,
  value: google.firestore.v1.IArrayValue
): unknown[] {
  const elems = decodeArrayTransform(serializer, value);
  // De-dupe by Firestore equality, preserving order
  return elems.filter(
    (el, idx) => elems.findIndex((e) => compareValues(e, el) === 0) === idx
  );
}
