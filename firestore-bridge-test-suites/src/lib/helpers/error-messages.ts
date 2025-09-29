import { FieldPath } from 'firebase-admin/firestore';
import { ErrorMessageFactory } from './error-message-factory.js';
import { formatPlural } from './format.js';
import { ReferenceType } from './types.js';

const UPDATE_ARG_ERROR =
  'Update() requires either a single JavaScript object or an alternating list of field/value pairs that can be followed by an optional precondition.';

const FIELD_PATH_TYPE = 'field path';
const RESOURCE_PATH_TYPE = 'resource path';
const SET_OPTIONS_ARG_TYPE = 'set() options argument';

export class ErrorMessages {
  static updatePreconditionExists(): string {
    return ErrorMessageFactory.init(UPDATE_ARG_ERROR)
      .argumentInvalidPart('preconditionOrValues', 'precondition')
      .append(
        '"exists" is not allowed to have the value false (allowed values: true)'
      )
      .toString();
  }

  static invalidArgument(arg: string | number, argType: string): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(arg, argType)
      .toString();
  }

  static customObject(
    argName: string | number,
    value: unknown,
    fieldPath?: string | FieldPath | undefined
  ): string {
    return ErrorMessageFactory.init()
      .argumentInvalidDocumentPart(argName)
      .customObjectPart(value, fieldPath ? `${fieldPath}` : undefined)
      .toString();
  }

  static fieldValueInArray(
    argName: string,
    methodName: string,
    fieldPath: string,
    elementIndex: number
  ): string {
    return ErrorMessageFactory.init()
      .argumentInvalidDocumentPart(argName)
      .fieldValueInArrayPart(methodName, fieldPath, elementIndex)
      .toString();
  }

  static invalidPathArgument(
    expectedType: ReferenceType,
    argName: string,
    path: string
  ): string {
    return ErrorMessageFactory.init()
      .pathArgumentInvalidPart(expectedType, argName, path)
      .invalidReferencePathLengthPart(expectedType)
      .toString();
  }

  static pathCannotBeOmitted(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, FIELD_PATH_TYPE)
      .append('The path cannot be omitted.')
      .toString();
  }

  static pathTypeInvalid(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, FIELD_PATH_TYPE)
      .append(
        'Paths can only be specified as strings or via a FieldPath object.'
      )
      .toString();
  }

  static pathHasDoubleDot(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, FIELD_PATH_TYPE)
      .append('Paths must not contain ".." in them.')
      .toString();
  }

  static pathInvalidDot(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, FIELD_PATH_TYPE)
      .append('Paths must not start or end with ".".')
      .toString();
  }

  static pathEmptyOrInvalidChar(argName: string | number): string {
    return (
      ErrorMessageFactory.init()
        .argumentInvalidPart(argName, FIELD_PATH_TYPE)
        // IMPORTANT! The NEWLINE is required to emulate the actual `firestore-admin` package message
        .append(
          `Paths can't be empty and must not contain
    "*~/[]".`
        )
        .toString()
    );
  }

  static resourcePathEmptyString(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, RESOURCE_PATH_TYPE)
      .append('Path must be a non-empty string.')
      .toString();
  }

  static resourcePathDoubleForwardSlash(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, RESOURCE_PATH_TYPE)
      .append('Paths must not contain //.')
      .toString();
  }

  static setOptionsInputNotObject(argName: string | number): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, SET_OPTIONS_ARG_TYPE)
      .append('Input is not an object.')
      .toString();
  }

  static setOptionsMergeFieldsInvalid(
    argName: string | number,
    message: string | undefined
  ): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, SET_OPTIONS_ARG_TYPE)
      .append(`"mergeFields" is not valid: ${message ?? ''}`)
      .toString();
  }

  static setOptionsMergeAndMergeFieldsSpecified(
    argName: string | number
  ): string {
    return ErrorMessageFactory.init()
      .argumentInvalidPart(argName, SET_OPTIONS_ARG_TYPE)
      .append('You cannot specify both "merge" and "mergeFields".')
      .toString();
  }

  static writeBatchCommitted(): string {
    return 'Cannot modify a WriteBatch that has been committed.';
  }

  static functionMinArgs(funcName: string, minSize: number): string {
    return (
      `Function "${funcName}()" requires at least ` +
      `${formatPlural(minSize, 'argument')}.`
    );
  }
}
