import { runTransactionSuite } from 'firestore-bridge-test-suites';
import { testContext } from './common/index.js';

runTransactionSuite(testContext());
