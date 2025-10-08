import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import * as v1 from 'firebase-functions/v1';
import { TriggerOrchestrator } from '../lib/trigger-orchestrator.js';
import * as Helpers from './common/orchestration-helpers.js';
import { orchestratorTestSuite } from './common/orchestrator-suite.js';

describe('v1 TriggerOrchestrator tests', () => {
  const env = new FirestoreMock();
  const ctrl = env.createDatabase();
  const firestore = ctrl.firestore();

  // --- v1 Trigger: users/{uid} onWrite ---
  const onUserWrite = v1.firestore
    .document(Helpers.PATH_USERS)
    .onWrite((change, context) => {
      Helpers.onUserWriteHandler(firestore, {
        before: change.before.exists
          ? (change.before.data() as Helpers.UserDoc)
          : undefined,
        after: change.after.exists
          ? (change.after.data() as Helpers.UserDoc)
          : undefined,
        context: { params: context.params },
      });
    });

  // --- v1 Trigger: posts/{postId} onCreate ---
  const onPostCreate = v1.firestore
    .document(Helpers.PATH_POSTS)
    .onCreate((snap, context) => {
      Helpers.onPostCreateHandler(firestore, snap.data() as Helpers.PostDoc, {
        params: context.params,
      });
    });

  // --- v1 Trigger: posts/{postId}/comments/{commentId} onWrite ---
  const onCommentWrite = v1.firestore
    .document(Helpers.PATH_COMMENTS)
    .onWrite((change, context) => {
      Helpers.onCommentWriteHandler(firestore, {
        before: change.before.exists
          ? (change.before.data() as Helpers.CommentDoc)
          : undefined,
        after: change.after.exists
          ? (change.after.data() as Helpers.CommentDoc)
          : undefined,
        context: { params: context.params },
      });
    });

  // Orchestrator: register all v1 triggers
  const triggers = new TriggerOrchestrator<Helpers.AppTrigger>(ctrl, (r) => {
    r.v1(Helpers.AppTrigger.OnUserWrite, onUserWrite);
    r.v1(Helpers.AppTrigger.OnPostCreate, onPostCreate);
    r.v1(Helpers.AppTrigger.OnCommentWrite, onCommentWrite);
  });

  orchestratorTestSuite('v1', env, ctrl, firestore, triggers);
});
