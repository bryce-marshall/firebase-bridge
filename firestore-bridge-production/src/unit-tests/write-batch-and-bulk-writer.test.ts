import { writeBatchingAndBulkWriterSuite } from 'firestore-bridge-test-suites';
import { testContext } from './common/index.js';

writeBatchingAndBulkWriterSuite(testContext());
