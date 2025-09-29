import { v1TriggerFactory } from './common/factory-v1.js';
import { triggerTestSuite } from './common/test-suite.js';

triggerTestSuite('firebase-functions/v1', v1TriggerFactory);
