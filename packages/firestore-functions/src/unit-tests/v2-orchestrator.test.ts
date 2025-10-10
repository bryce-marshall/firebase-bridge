import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import {
    onDocumentCreated,
    onDocumentWritten,
} from 'firebase-functions/v2/firestore';
import { TriggerOrchestrator } from '../lib/trigger-orchestrator.js';
import * as Helpers from './common/orchestration-helpers.js';
import { orchestratorTestSuite } from './common/orchestrator-suite.js';

describe('v2 TriggerOrchestrator tests', () => {
  const env = new FirestoreMock();
  const ctrl = env.createDatabase();
  const firestore = ctrl.firestore();

  // --- v2 Trigger: users/{uid} onWrite ---
  const onUserWrite = onDocumentWritten(Helpers.PATH_USERS, async (event) => {
    await Helpers.onUserWriteHandler(firestore, {
      before: event.data?.before?.exists
        ? (event.data.before.data() as Helpers.UserDoc)
        : undefined,
      after: event.data?.after?.exists
        ? (event.data.after.data() as Helpers.UserDoc)
        : undefined,
      context: { params: event.params ?? {} },
    });
  });

  // --- v2 Trigger: posts/{postId} onCreate ---
  const onPostCreate = onDocumentCreated(Helpers.PATH_POSTS,async  (event) => {
    // event.data is the created snapshot
    await Helpers.onPostCreateHandler(
      firestore,
      event.data?.data() as Helpers.PostDoc,
      { params: event.params ?? {} }
    );
  });

  // --- v2 Trigger: posts/{postId}/comments/{commentId} onWrite ---
  const onCommentWrite = onDocumentWritten(Helpers.PATH_COMMENTS, async (event) => {
    await Helpers.onCommentWriteHandler(firestore, {
      before: event.data?.before?.exists
        ? (event.data.before.data() as Helpers.CommentDoc)
        : undefined,
      after: event.data?.after?.exists
        ? (event.data.after.data() as Helpers.CommentDoc)
        : undefined,
      context: { params: event.params ?? {} },
    });
  });

  // Orchestrator: register all v2 triggers
  const triggers = new TriggerOrchestrator<Helpers.AppTrigger>(ctrl, (r) => {
    r.v2(Helpers.AppTrigger.OnUserWrite, onUserWrite);
    r.v2(Helpers.AppTrigger.OnPostCreate, onPostCreate);
    r.v2(Helpers.AppTrigger.OnCommentWrite, onCommentWrite);
  });

  orchestratorTestSuite('v2', env, ctrl, firestore, triggers);
});
