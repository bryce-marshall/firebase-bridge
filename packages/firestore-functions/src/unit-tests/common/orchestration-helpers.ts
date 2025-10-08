import { Firestore } from 'firebase-admin/firestore';

// ---------- Firestore Path Constants ----------

/**
 * Canonical Firestore route templates used by all test triggers.
 * These paths mirror the document hierarchy expected by the handlers.
 */

/** Users top-level collection. */
export const PATH_USERS = 'users/{uid}';

/** Posts top-level collection. */
export const PATH_POSTS = 'posts/{postId}';

/** Comments subcollection under a post. */
export const PATH_COMMENTS = 'posts/{postId}/comments/{commentId}';

/** Specific seed comment created by OnPostCreate handler. */
export const PATH_COMMENT_SEED = 'posts/{postId}/comments/seed';

/** Audit collection written by OnCommentWrite handler. */
export const PATH_AUDIT_COMMENT = 'audits/comments/{postId}/{commentId}';

/** Deterministic welcome post created by OnUserWrite handler. */
export const PATH_WELCOME_POST = 'posts/{uid}-welcome';

/**
 * Array of all path templates for convenience when priming or iterating.
 */
export const ALL_TRIGGER_PATHS = [
  PATH_USERS,
  PATH_POSTS,
  PATH_COMMENTS,
  PATH_COMMENT_SEED,
  PATH_AUDIT_COMMENT,
  PATH_WELCOME_POST,
] as const;

/**
 * Common types and cloud-function-agnostic trigger handlers
 * with downstream writes to exercise cascading triggers.
 *
 * Handlers are side-effectful by design (writes to Firestore) but avoid
 * writing back to the originating document to prevent loops.
 */

// ---------- Document Types ----------

/** User profile document used for write tests. */
export type UserDoc = {
  /** Controls success/failure in tests (false => throw). */
  ok?: boolean;
  role?: 'admin' | 'user';
  emailVerified?: boolean;
  version?: number;
};

/** Blog post document used for create tests. */
export type PostDoc = {
  title?: string;
  status?: 'draft' | 'published';
  /** Optional flag handy for predicate-based waits. */
  indexRequested?: boolean;
};

/** Comment document used for nested write tests. */
export type CommentDoc = {
  body?: string;
  /** When true, handler throws to simulate failure. */
  toxic?: boolean;
};

// ---------- Trigger Keys ----------

/** Logical trigger identifiers used by TriggerOrchestrator. */
export enum AppTrigger {
  OnUserWrite = 'OnUserWrite',
  OnPostCreate = 'OnPostCreate',
  OnCommentWrite = 'OnCommentWrite',
}

// ---------- CF-Agnostic Shapes ----------

/** Minimal context bag (route params). */
export interface WriteContext {
  /** Route params like { uid, postId, commentId }. */
  params?: Record<string, string>;
}

/** Generic write change shape independent of v1/v2 SDKs. */
export interface WriteChange<T> {
  /** Previous document data (undefined when not present). */
  before: T | undefined;
  /** New document data (undefined on deletes). */
  after: T | undefined;
  /** Optional context bag. */
  context?: WriteContext;
}

/** Generic onWrite handler signature (with Firestore). */
export type OnWriteHandler<T> = (
  db: Firestore,
  change: WriteChange<T>
) => void | Promise<void>;

/** Generic onCreate handler signature (with Firestore). */
export type OnCreateHandler<T> = (
  db: Firestore,
  snap: T,
  ctx?: WriteContext
) => void | Promise<void>;

// ---------- Error Codes (stable for assertions) ----------

export const ERR_USER_WRITE_FAIL = 'USER_WRITE_FAIL' as const;
export const ERR_POST_CREATE_MISSING_TITLE =
  'POST_CREATE_MISSING_TITLE' as const;
export const ERR_COMMENT_TOXIC = 'COMMENT_TOXIC' as const;

// ---------- Path Helpers (deterministic) ----------

/** Deterministic post id derived from uid to avoid collisions/loops. */
export function welcomePostId(uid: string): string {
  return `${uid}-welcome`;
}

/** Seed comment id used by the post-create cascade. */
export const SEED_COMMENT_ID = 'seed' as const;

// ---------- CF-Agnostic Handlers WITH WRITES ----------

/**
 * User write handler.
 * - Throws ERR_USER_WRITE_FAIL when `after.ok === false`.
 * - On *first create* (no `before`), creates a welcome post at:
 *   `posts/{uid}-welcome` with a default title.
 * - On *updates* where `version` increases, optionally updates the post title.
 *   (Keeps behavior deterministic and avoids loops back to the user doc.)
 */
export const onUserWriteHandler: OnWriteHandler<UserDoc> = async (
  db,
  change
) => {
  const { before, after, context } = change;
  const uid = context?.params?.uid ?? 'unknown';

  // Failure path toggle
  if (after?.ok === false) {
    throw new Error(ERR_USER_WRITE_FAIL);
  }

  // Touch fields to enable predicate tests without side effects.
  void after?.role;
  void after?.emailVerified;
  const beforeVersion = before?.version ?? 0;
  const afterVersion = after?.version ?? beforeVersion;

  // Cascade: create a welcome post on first user create.
  if (!before && after) {
    const postId = welcomePostId(uid);
    await db.doc(`posts/${postId}`).set({
      title: after.emailVerified ? `Welcome, ${uid}!` : 'Welcome',
      status: 'draft',
      indexRequested: false,
    } satisfies PostDoc);
    // This creation should fire OnPostCreate.
  } else if (after && afterVersion > beforeVersion) {
    // Optional: reflect version bump in the post title (no new triggers beyond OnPostCreate).
    const postId = welcomePostId(uid);
    await db.doc(`posts/${postId}`).set(
      {
        title: `Welcome v${afterVersion}`,
      },
      { merge: true }
    );
  }
};

/**
 * Post create handler.
 * - Throws ERR_POST_CREATE_MISSING_TITLE when `title` is missing/empty.
 * - On success, creates a seed comment at:
 *   `posts/{postId}/comments/seed` with a benign body (`'ok'`).
 *   This is intended to fire `OnCommentWrite`.
 */
export const onPostCreateHandler: OnCreateHandler<PostDoc> = async (
  db,
  snap,
  ctx
) => {
  if (!snap?.title) {
    throw new Error(ERR_POST_CREATE_MISSING_TITLE);
  }

  const postId = ctx?.params?.postId ?? 'unknown';
  await db.doc(`posts/${postId}/comments/${SEED_COMMENT_ID}`).set({
    body: 'ok',
    toxic: false,
  } satisfies CommentDoc);
};

/**
 * Comment write handler (nested path).
 * - Throws ERR_COMMENT_TOXIC when `after.toxic === true`.
 * - On success, writes a lightweight audit record to a side collection:
 *   `audits/comments/{postId}_{commentId}` (no further triggers).
 */
export const onCommentWriteHandler: OnWriteHandler<CommentDoc> = async (
  db,
  change
) => {
  const { before, after, context } = change;
  const postId = context?.params?.postId ?? 'unknownPost';
  const commentId = context?.params?.commentId ?? 'unknownComment';

  if (after?.toxic === true) {
    throw new Error(ERR_COMMENT_TOXIC);
  }

  // Write an audit that won't cause further triggers.
  await db.doc(`audits/comments/${postId}/${commentId}`).set({
    created: !before && !!after,
    updated: !!before && !!after,
    deleted: !!before && !after,
    snapshot: after ?? null,
  });
};

// ---------- Optional: tiny adapters (helpers) ----------

/**
 * Helper to build a generic WriteChange from raw before/after data.
 * Useful in unit tests or thin wrappers around v1/v2 payloads.
 */
export function makeWriteChange<T>(
  before: T | undefined,
  after: T | undefined,
  context?: WriteContext
): WriteChange<T> {
  return { before, after, context };
}
