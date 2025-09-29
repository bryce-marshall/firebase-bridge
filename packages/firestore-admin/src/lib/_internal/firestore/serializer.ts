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

import type { google } from '@gcf/firestore-protos';
import { DocumentData, Firestore } from 'firebase-admin/firestore';
import { ApiMapValue } from './types.js';

/**
 * Internal duck-typed view of a Firestore instance that exposes its
 * **native internal** serializer.
 *
 * This is the serializer constructed by the Firestore SDK itself and
 * used by subordinate objects (e.g., `DocumentReference`, `CollectionReference`,
 * snapshots, etc.) for encoding/decoding.
 *
 * @internal
 */
interface _Host {
  _serializer: Serializer;
}

/**
 * Returns the Firestore SDK’s **internal native** {@link Serializer} associated
 * with the provided `Firestore` instance.
 *
 * Implementation notes:
 * - This performs an **unsafe cast** to access a private implementation detail
 *   (`_serializer`) that the Firestore SDK instantiates and shares with its
 *   subordinate objects. We are not attaching our own serializer; we are
 *   retrieving the SDK’s existing one.
 * - This is **version-fragile**: the private field name or shape may change in
 *   future SDK releases.
 * - The returned serializer is the live instance used by the SDK; no cloning is performed.
 *
 * @param firestore - A Firestore instance from which to retrieve the internal serializer.
 * @returns The SDK’s internal {@link Serializer} used for value (de)serialization.
 * @internal
 *
 * @example
 * const serializer = getSerializer(firestore);
 * const pojo = serializer.decodeValue(protoValue);
 */
export function getSerializer(firestore: Firestore): Serializer {
  return (firestore as unknown as _Host)._serializer;
}

/**
 * Serializer that is used to convert between JavaScript types and their
 * Firestore Protobuf representation.
 */
export interface Serializer {
  /**
   * Encodes a JavaScript object into the Firestore 'Fields' representation.
   *
   * @private
   * @internal
   * @param obj The object to encode.
   * @returns The Firestore 'Fields' representation
   */
  encodeFields(obj: DocumentData): ApiMapValue;
  /**
   * Encodes a JavaScript value into the Firestore 'Value' representation.
   *
   * @private
   * @internal
   * @param val The object to encode
   * @returns The Firestore Proto or null if we are deleting a field.
   */
  encodeValue(val: unknown): google.firestore.v1.IValue | null;
  /**
   * @private
   */
  encodeVector(rawVector: number[]): google.firestore.v1.IValue;
  /**
   * Decodes a single Firestore 'Value' Protobuf.
   *
   * @private
   * @internal
   * @param proto A Firestore 'Value' Protobuf.
   * @returns The converted JS type.
   */
  decodeValue(proto: google.firestore.v1.IValue): unknown;
  /**
   * Decodes a google.protobuf.Value
   *
   * @private
   * @internal
   * @param proto A Google Protobuf 'Value'.
   * @returns The converted JS type.
   */
  decodeGoogleProtobufValue(proto: google.protobuf.IValue): unknown;
  /**
   * Decodes a google.protobuf.ListValue
   *
   * @private
   * @internal
   * @param proto A Google Protobuf 'ListValue'.
   * @returns The converted JS type.
   */
  decodeGoogleProtobufList(
    proto: google.protobuf.IListValue | null | undefined
  ): unknown[];
  /**
   * Decodes a google.protobuf.Struct
   *
   * @private
   * @internal
   * @param proto A Google Protobuf 'Struct'.
   * @returns The converted JS type.
   */
  decodeGoogleProtobufStruct(
    proto: google.protobuf.IStruct | null | undefined
  ): Record<string, unknown>;
}
