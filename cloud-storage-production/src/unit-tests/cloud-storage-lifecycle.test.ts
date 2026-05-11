import {
  cloudStorageErrorModelSuite,
  cloudStorageLifecycleSuite,
  cloudStorageListingSuite,
  cloudStorageMetadataSuite,
  cloudStoragePreconditionsSuite,
} from 'cloud-storage-test-suites';
import { testContext } from './common/index.js';

cloudStorageLifecycleSuite(testContext());
cloudStorageErrorModelSuite(testContext());
cloudStorageMetadataSuite(testContext());
cloudStoragePreconditionsSuite(testContext());
cloudStorageListingSuite(testContext());
