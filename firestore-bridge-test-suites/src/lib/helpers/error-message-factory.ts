import { ReferenceType } from './types.js';
import { isObject } from './util.js';

/**
 * Actual error messages can be found at
 * https://github.com/googleapis/nodejs-firestore/blob/main/dev/src/validate.ts
 */

/**
 *
 */
export class ErrorMessageFactory {
  private _parts: string[] = [];

  private constructor(initialParts?: string | string[]) {
    if (typeof initialParts === 'string') {
      this._parts.push(initialParts);
    } else if (Array.isArray(initialParts)) {
      this._parts.push(...initialParts);
    }
  }

  static init(initialParts?: string | string[]): ErrorMessageFactory {
    return new ErrorMessageFactory(initialParts);
  }

  argumentInvalidDocumentPart(argName: string | number): this {
    return this.append(
      `Value for argument "${argName}" is not a valid Firestore document.`
    );
  }

  customObjectPart(value: unknown, fieldPath: string | undefined): this {
    const fieldPathMessage = fieldPath
      ? ` (found in field "${fieldPath}")`
      : '';

    if (isObject(value)) {
      const typeName = value.constructor.name;
      switch (typeName) {
        case 'DocumentReferenceImpl':
        case 'DocumentReference':
        case 'FieldPathImpl':
        case 'FieldPath':
        case 'FieldValueImpl':
        case 'FieldValue':
        case 'GeoPointImpl':
        case 'GeoPoint':
        case 'TimestampImpl':
        case 'Timestamp':
          // IMPORTANT! The trailing `)` typo at the end of the following message segment is intentional,
          // as it exists in the current `firestore-admin` package.
          this.append(
            `Detected an object of type "${typeName}" that doesn't match the ` +
              `expected instance${fieldPathMessage}. Please ensure that the ` +
              'Firestore types you are using are from the same NPM package.)'
          );
          break;
        case 'Object':
          this.append(
            `Invalid use of type "${typeof value}" as a Firestore argument${fieldPathMessage}.`
          );
          break;
        default:
          this.append(
            `Couldn't serialize object of type "${typeName}"${fieldPathMessage}. Firestore doesn't support JavaScript ` +
              'objects with custom prototypes (i.e. objects that were created ' +
              'via the "new" operator).'
          );
      }
    } else {
      this.append(`Input is not a plain JavaScript object${fieldPathMessage}.`);
    }

    return this;
  }

  fieldValueInArrayPart(
    methodName: string,
    fieldPath: string,
    elementIndex: number
  ): this {
    return this.append(
      `FieldValue.${methodName}() cannot be used inside of an array`
    ).foundInFieldPart(`${fieldPath}.\`${elementIndex}\``);
  }

  foundInFieldPart(fieldPath: string): this {
    return this.append(`(found in field "${fieldPath}").`);
  }

  pathArgumentInvalidPart(
    expectedType: ReferenceType,
    argName: string,
    path: string
  ): this {
    return this.append(
      `Value for argument "${argName}" must point to a ${expectedType}, but was "${path}".`
    );
  }

  argumentInvalidPart(argName: string | number, argType: string): this {
    return this.append(
      `${formatArgumentName(argName)} is not a valid ${argType}.`
    );
  }

  invalidReferencePathLengthPart(
    expected: ReferenceType,
  ): ErrorMessageFactory {
    return this.append(
      `Your path does not contain an ${
        expected === 'collection' ? 'odd' : 'even'
      } number of components.`
    );
  }

  append(part: string): this {
    this._parts.push(part);

    return this;
  }

  toString(): string {
    if (this._parts.length === 0) return '';
    let msg = this._parts[0];
    for (let i = 1; i < this._parts.length; i++) {
      const part = this._parts[i];
      if (part?.length > 0) {
        msg += ' ' + this._parts[i];
      }
    }

    return msg;
  }
}

function formatArgumentName(arg: string | number): string {
  return typeof arg === 'string'
    ? `Value for argument "${arg}"`
    : `Element at index ${arg}`;
}
