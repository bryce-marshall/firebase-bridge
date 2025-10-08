import {
  FirestoreController,
  TriggerEventArg,
} from '@firebase-bridge/firestore-admin';
import { DocumentSnapshot } from 'firebase-admin/firestore';
import { CloudContext } from './cloud-context.js';
import {
  RegisterTriggerOptions,
  TriggerErrorOrigin,
  TriggerRunnerErrorEventArg,
} from '../types.js';
import {
  buildCloudEvent,
  GenericTriggerEventData,
  Kind,
  toChangeRecord
} from './util.js';

export interface GenericTriggerMeta {
  route: string;
  kinds: (Kind | 'write')[];
}

export abstract class TriggerRunner<THandler> {
  readonly unsub: () => void;

  constructor(
    target: FirestoreController,
    handler: THandler,
    options?: RegisterTriggerOptions
  ) {
    const opt = { ...options };
    const { route, kinds } = this.getTriggerMeta(target, handler);

    this.unsub = target.database.registerTrigger({
      route,
      callback: (arg: TriggerEventArg) => {
        let origin = TriggerErrorOrigin.Predicate;

        function emitError(cause: unknown): void {
          const errorArg: TriggerRunnerErrorEventArg = {
            origin,
            arg,
            cause,
          };

          Object.freeze(errorArg);
          try {
            opt.onError?.(errorArg);
          } catch {
            // noop
          }
        }

        try {
          if ((opt?.predicate?.(arg) ?? true) !== true) return;

          type EmitKind = Kind | 'write';
          const firestore = target.firestore();
          const rec = toChangeRecord(firestore, arg.doc);
          if (!rec?.kind) return; // ignore no-op writes
          const emitKind: EmitKind = kinds.includes('write')
            ? 'write'
            : rec.kind;
          if (emitKind !== 'write' && !kinds.includes(emitKind)) return;

          const data = buildCloudEvent(
            target,
            emitKind,
            arg,
            rec.before as DocumentSnapshot,
            rec.after as DocumentSnapshot
          );

          // Wrap the process in minimal Cloud Functions-like environment variables when executing (resets after)
          CloudContext.start(target, async () => {
            try {
              origin = TriggerErrorOrigin.OnBefore;
              opt.onBefore?.(arg);
              origin = TriggerErrorOrigin.Execute;
              await this.run(handler, arg, data);
              origin = TriggerErrorOrigin.OnAfter;
              opt.onAfter?.(arg);
            } catch (cause) {
              emitError(cause);
            }
          });
        } catch (cause) {
          emitError(cause);
        }
      },
    });
  }

  abstract getTriggerMeta(
    target: FirestoreController,
    handler: THandler
  ): GenericTriggerMeta;

  abstract run(
    handler: THandler,
    arg: TriggerEventArg,
    data: GenericTriggerEventData
  ): unknown | Promise<unknown>;
}
