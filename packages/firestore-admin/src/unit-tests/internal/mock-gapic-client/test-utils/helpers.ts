import { GoogleError } from 'google-gax';
import internal, { Duplex } from 'stream';
import {
  ClauseSpec,
  CompositeOp,
  createValueRangeDocs,
  IndexableFieldType,
  IndexableFieldValue,
  makeCompositeFilterRequest,
  makeSingleFilter,
  ValueTransformerArg,
} from './data-helpers';
import { google } from './google';
import { MockGapicTestContext } from './mock-factories';

export class ProtoHelper {
  static timestamp(
    value: google.protobuf.ITimestamp
  ): google.protobuf.ITimestamp {
    return {
      nanos: value.nanos || 0,
      seconds: Number(value.seconds || 0).toString(),
    };
  }
}

export async function execSingleFilterQuery<
  T extends IndexableFieldValue = IndexableFieldValue
>(
  mock: MockGapicTestContext,
  type: IndexableFieldType,
  op: google.firestore.v1.StructuredQuery.FieldFilter.Operator,
  index: number | number[],
  valueTransformer?: (arg: ValueTransformerArg) => T | T[]
): Promise<string[]> {
  createValueRangeDocs(mock, type, valueTransformer);
  const request = makeSingleFilter(mock, type, op, index);
  const docs = await executeQuery(mock, request);

  return docs;
}

export function execCompositeFilterQuery<
  T extends IndexableFieldValue = IndexableFieldValue
>(
  mock: MockGapicTestContext,
  type: IndexableFieldType,
  specs: ClauseSpec[],
  compositeOp: CompositeOp = 'AND',
  valueTransformer?: (arg: ValueTransformerArg) => T | T[]
): Promise<string[]> {
  createValueRangeDocs(mock, type, valueTransformer);
  const request = makeCompositeFilterRequest(mock, specs, compositeOp);
  return executeQuery(mock, request);
}

export async function executeQuery(
  mock: MockGapicTestContext,
  request: google.firestore.v1.IRunQueryRequest
): Promise<string[]> {
  const stream: Duplex = mock.client.runQuery(request);

  const docs: string[] = [];
  await new Promise<string[]>((resolve, reject) => {
    stream.on('data', (resp: google.firestore.v1.IRunQueryResponse) => {
      if (resp.document) {
        const name = mock.context.toInternalPath(
          resp.document.name,
          'document'
        );
        docs.push(name);
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return docs;
}

export function runQueryExpectOk(
  Mock: MockGapicTestContext,
  req: Partial<google.firestore.v1.IRunQueryRequest>
): Promise<void> {
  return duplexExpectOk(() => Mock.client.runQuery(req));
}

export function runQueryExpectError(
  Mock: MockGapicTestContext,
  req: Partial<google.firestore.v1.IRunQueryRequest>
): Promise<GoogleError> {
  return duplexExpectError(() => Mock.client.runQuery(req));
}

export function runAggregationQueryExpectOk(
  Mock: MockGapicTestContext,
  req: Partial<google.firestore.v1.IRunAggregationQueryRequest>
): Promise<void> {
  return duplexExpectOk(() => Mock.client.runAggregationQuery(req));
}

export function runAggregationQueryExpectError(
  Mock: MockGapicTestContext,
  req: Partial<google.firestore.v1.IRunAggregationQueryRequest>
): Promise<GoogleError> {
  return duplexExpectError(() => Mock.client.runAggregationQuery(req));
}

export function duplexExpectOk(executor: () => internal.Duplex): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = executor();
    stream.on('error', (err) => reject(err));
    // We don't care whether there are results; only that no error fires.
    stream.on('end', () => resolve());
    // In some implementations a final empty response is emitted; also resolve on first data.
    stream.on('data', () => {
      // allow stream to end naturally; don't resolve early to avoid leaks
    });
  });
}

export function duplexExpectError(
  executor: () => internal.Duplex
): Promise<GoogleError> {
  return new Promise((resolve, reject) => {
    const stream = executor();
    let sawData = false;

    stream.on('data', () => {
      sawData = true;
    });
    stream.on('error', (err: Error) => {
      if (sawData) {
        reject(
          new Error(
            `Expected validation error before any data; saw data first. Error: ${err?.message}`
          )
        );
      } else {
        resolve(err);
      }
    });
    stream.on('end', () => {
      reject(new Error('Stream ended without emitting an expected error'));
    });
  });
}

export function isInequalityOperator(
  op: google.firestore.v1.StructuredQuery.FieldFilter.Operator
): boolean {
  switch (op) {
    case 'GREATER_THAN':
    case 'GREATER_THAN_OR_EQUAL':
    case 'LESS_THAN':
    case 'LESS_THAN_OR_EQUAL':
    case 'NOT_EQUAL':
    case 'NOT_IN':
      return true;
  }

  return false;
}
