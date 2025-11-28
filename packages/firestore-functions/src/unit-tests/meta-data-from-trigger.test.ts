import { getTriggerMeta as getTriggerMetaV1 } from '../lib/v1/meta-helper.js';
import { getTriggerMeta as getTriggerMetaV2 } from '../lib/v2/meta-helper.js';

const v1_endpoint = {
  platform: 'gcfv1',
  eventTrigger: {
    eventType: 'providers/cloud.firestore/eventTypes/document.create',
    eventFilters: {
      resource:
        'projects/default-project/databases/(default)/documents/col1/{userId}/posts/{postId}',
    },
    retry: false,
  },
};

const v2_endpoint = {
  platform: 'gcfv2',
  labels: {},
  eventTrigger: {
    eventType: 'google.cloud.firestore.document.v1.created',
    eventFilters: {
      database: '(default)',
      namespace: '(default)',
    },
    eventFilterPathPatterns: {
      document: 'col1/{userId}/posts/{postId}',
    },
    retry: false,
  },
};

const ExpectedMeta = {
  route: 'col1/{userId}/posts/{postId}',
  kinds: ['create'],
};

describe('v1 Standalone trigger tests', () => {
  it('resolves v1 meta', () => {
    const meta = getTriggerMetaV1(v1_endpoint);
    expect(meta).toEqual(ExpectedMeta);
  });

  it('resolves v2 meta', () => {
    const meta = getTriggerMetaV2(v2_endpoint);
    expect(meta).toEqual(ExpectedMeta);
  });
});
