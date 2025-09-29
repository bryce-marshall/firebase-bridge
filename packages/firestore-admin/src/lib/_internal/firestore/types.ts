/*!
 * Copyright 2018 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modifications Copyright (c) 2025 Bryce Marshall
 */

// Adapted from https://github.com/googleapis/nodejs-firestore/blob/main/dev/src/types.ts

import type { google } from '@gcf/firestore-protos';

import { CallOptions } from 'google-gax';
import { Duplex } from 'stream';

/**
 * A map in the format of the Proto API
 */
export interface ApiMapValue {
  [k: string]: google.firestore.v1.IValue;
}

/**
 * The subset of methods we use from FirestoreClient.
 *
 * We don't depend on the actual Gapic client to avoid loading the GAX stack at
 * module initialization time.
 */
export interface GapicClient {
  getProjectId(): Promise<string>;
  beginTransaction(
    request: google.firestore.v1.IBeginTransactionRequest,
    options?: CallOptions
  ): Promise<[google.firestore.v1.IBeginTransactionResponse, unknown, unknown]>;
  commit(
    request: google.firestore.v1.ICommitRequest,
    options?: CallOptions
  ): Promise<[google.firestore.v1.ICommitResponse, unknown, unknown]>;
  batchWrite(
    request: google.firestore.v1.IBatchWriteRequest,
    options?: CallOptions
  ): Promise<[google.firestore.v1.IBatchWriteResponse, unknown, unknown]>;
  rollback(
    request: google.firestore.v1.IRollbackRequest,
    options?: CallOptions
  ): Promise<[google.protobuf.IEmpty, unknown, unknown]>;
  batchGetDocuments(
    request?: google.firestore.v1.IBatchGetDocumentsRequest,
    options?: CallOptions
  ): Duplex;
  runQuery(
    request?: google.firestore.v1.IRunQueryRequest,
    options?: CallOptions
  ): Duplex;
  runAggregationQuery(
    request?: google.firestore.v1.IRunAggregationQueryRequest,
    options?: CallOptions
  ): Duplex;
  listDocuments(
    request: google.firestore.v1.IListDocumentsRequest,
    options?: CallOptions
  ): Promise<[google.firestore.v1.IDocument[], unknown, unknown]>;
  listCollectionIds(
    request: google.firestore.v1.IListCollectionIdsRequest,
    options?: CallOptions
  ): Promise<[string[], unknown, unknown]>;
  listen(options?: CallOptions): Duplex;
  partitionQueryStream(
    request?: google.firestore.v1.IPartitionQueryRequest,
    options?: CallOptions
  ): Duplex;
  close(): Promise<void>;
}
