import { FirestoreMock } from '@firebase-bridge/firestore-admin';
import { registerTrigger as triggerV1 } from '@firebase-bridge/firestore-functions/v1';
import { registerTrigger as triggerV2 } from '@firebase-bridge/firestore-functions/v2';
import * as v1 from 'firebase-functions/v1';
import * as v2 from 'firebase-functions/v2';

/* ───────────────────────────── Pretty logger ───────────────────────────── */

function supportsColor(stream: NodeJS.WriteStream | undefined) {
  // Hard opt-out
  if ('NO_COLOR' in process.env || process.env.TERM === 'dumb') return false;

  // Hard opt-in with FORCE_COLOR:
  //  - "0" disables, any other defined value enables
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR) return true;

  // TTY present? (covers most local terminals, including Windows)
  if (stream && stream.isTTY) return true;

  // Some CI environments still support ANSI
  if (process.env.CI && (process.env.GITHUB_ACTIONS || process.env.GITLAB_CI)) {
    return true;
  }

  return false;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
} as const;

function color(enabled: boolean, code: string, s: string) {
  return enabled ? `${code}${s}${ANSI.reset}` : s;
}

function prettyPrint(
  title: string,
  fields: Record<string, unknown> = {},
  payload?: unknown
): void {
  const useColor = supportsColor(
    process.stdout as NodeJS.WriteStream | undefined
  );

  const borderColor = (s: string) => color(useColor, ANSI.gray, s);
  const titleColor = (s: string) => color(useColor, ANSI.cyan, s);
  const keyColor = (s: string) => color(useColor, ANSI.bold, s);
  const timeColor = (s: string) => color(useColor, ANSI.dim, s);

  // Strip ANSI for correct width calculations
  // eslint-disable-next-line no-control-regex
  const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
  const visibleLen = (s: string) => s.replace(ANSI_RE, '').length;

  const columns = Math.max(60, process.stdout.columns ?? 100);
  const hr = (cLeft: string, cFill: string, cRight: string) =>
    `${cLeft}${cFill.repeat(columns - 2)}${cRight}`;

  const top = borderColor(hr('┏', '━', '┓'));
  const mid = borderColor(hr('┣', '━', '┫'));
  const bot = borderColor(hr('┗', '━', '┛'));

  const line = (s = '') => {
    const raw = ` ${s}`;
    const padLen = Math.max(0, columns - 2 - visibleLen(raw));
    console.log(borderColor('┃') + raw + ' '.repeat(padLen) + borderColor('┃'));
  };

  // Left/Right content on the same line (e.g., title ... timestamp)
  const lineLR = (left: string, right: string) => {
    const leftRaw = ` ${left}`;
    const padLen = Math.max(
      0,
      columns - 2 - (visibleLen(leftRaw) + visibleLen(right))
    );
    console.log(
      borderColor('┃') + leftRaw + ' '.repeat(padLen) + right + borderColor('┃')
    );
  };

  console.log(top);

  // Title (left) and ISO timestamp (right), both colorized but padded by visible width
  lineLR(titleColor(title), timeColor(new Date().toISOString()));

  console.log(mid);

  // Keys padded BEFORE coloring; value printed after colon
  const maxKey = Math.max(0, ...Object.keys(fields).map((k) => k.length));
  for (const [k, v] of Object.entries(fields)) {
    const left = `${keyColor(k.padEnd(maxKey))}: ${String(v)}`;
    line(left);
  }

  if (payload !== undefined) {
    console.log(mid);
    const json = JSON.stringify(payload, null, 2) ?? '';
    for (const ln of json.split('\n')) line(ln);
  }

  console.log(bot);
}

/* ───────────────────────────── Triggers ───────────────────────────── */

const EventPath = 'users/{uid}';

const onUserCreateV1 = v1.firestore
  .document(EventPath)
  .onCreate(async (snap, ctx) => {
    prettyPrint(
      'v1.firestore.onCreate',
      {
        eventId: ctx.eventId,
        eventType: ctx.eventType,
        timestamp: ctx.timestamp,
        path: snap.ref.path,
      },
      {
        route: EventPath,
        params: ctx.params,
        resource: ctx.resource,
        data: snap.data?.(),
      }
    );
  });

const onUserWrittenV2 = v2.firestore.onDocumentWritten(
  EventPath,
  async (event) => {
    const beforeData = event.data?.before
      ? event.data.before.data()
      : undefined;
    const afterData = event.data?.after ? event.data.after.data() : undefined;

    prettyPrint(
      'v2.firestore.onDocumentWritten',
      {
        specversion: event.specversion,
        eventId: event.id,
        type: event.type,
        time: event.time,
        document: event.document,
        source: event.source,
        subject: event.subject,
        location: event.location,
        namespace: event.namespace,
        project: event.project,
        database: event.database,
      },
      {
        route: EventPath,
        params: event.params,
        before: beforeData,
        after: afterData,
      }
    );
  }
);

async function main(): Promise<void> {
  const mock = new FirestoreMock();
  const ctrl = mock.createDatabase();
  const firestore = ctrl.firestore();

  triggerV1(ctrl, onUserCreateV1);
  triggerV2(ctrl, onUserWrittenV2);

  const doc = firestore.doc('users/id-1234');
  await doc.set({ name: 'John' });
}

main();
