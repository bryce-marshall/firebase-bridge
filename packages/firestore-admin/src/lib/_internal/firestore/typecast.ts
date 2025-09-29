import type { google } from '@gcf/firestore-protos';
import { Settings, Timestamp } from 'firebase-admin/firestore';

export interface WithFirestoreSettings {
  _settings?: Settings;
}

export interface ToProto {
  toProto(): google.firestore.v1.IValue;
}

/**
 * Generates a `Timestamp` object from a Timestamp proto.
 *
 * @private
 * @internal
 * @param {Object} timestamp The `Timestamp` Protobuf object.
 */
export interface TimestampFromProto {
  fromProto(timestamp: google.protobuf.ITimestamp): Timestamp;
}
