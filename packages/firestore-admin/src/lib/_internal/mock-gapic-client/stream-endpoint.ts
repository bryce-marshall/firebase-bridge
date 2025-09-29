import { GoogleError, Status } from 'google-gax';
import { Duplex } from 'stream';
import { googleError } from '../functions/google-error.js';
import { resolvePromise } from '../functions/resolve-promise.js';

const OWNER = Symbol('owner');

/**
 * Maintains a set of active {@link StreamEndpoint} instances.
 *
 * Used by the mock Gapic client to track all open streams (e.g. active
 * listeners). Provides registration and bulk-destroy semantics.
 */
export class StreamCollection {
  private _endpoints = new Set<StreamEndpoint<unknown>>();

  /**
   * Registers an endpoint into this collection.
   *
   * @throws {GoogleError} INTERNAL if the endpoint is already registered.
   * @param endpoint The endpoint to track.
   */
  register(endpoint: StreamEndpoint<unknown>): void {
    if (endpoint[OWNER])
      throw googleError(Status.INTERNAL, 'Stream already registered.');
    endpoint[OWNER] = this._endpoints;
    this._endpoints.add(endpoint);
  }

  /**
   * Destroys the collection by closing all tracked endpoints and
   * clearing the internal set.
   *
   * Each endpoint’s {@link StreamEndpoint.close} method is invoked.
   */
  destroy(): Promise<void> {
    const endpoints = Array.from(this._endpoints.values());
    this._endpoints.clear();
    const closing: Promise<void>[] = [];
    endpoints.forEach((ep) => {
      closing.push(ep.close());
    });

    return Promise.all(closing).then(() => undefined);
  }
}

/**
 * Signature for callbacks provided by the Node.js streams API to
 * acknowledge completion of a write operation.
 */
type StreamWriteCallback = (error?: Error | null) => void;

/**
 * Abstract base class representing a bidirectional streaming endpoint
 * (e.g. a Firestore listen channel).
 *
 * Provides a Node.js {@link Duplex} stream configured for object mode,
 * error-wrapped write handling, and graceful close/abort semantics.
 *
 * Subclasses implement {@link onWrite} to process requests written
 * by the client. Server responses should be pushed onto the duplex
 * stream via `this.duplex.push()`.
 *
 * @typeParam TRequest Type of request objects written by the client.
 */
export abstract class StreamEndpoint<TRequest> {
  /** Owning collection (if registered). */
  private [OWNER]?: Set<StreamEndpoint<unknown>>;

  private _isClosed = false;

  /** Duplex stream representing this endpoint. */
  readonly duplex: Duplex;

  /**
   * Creates a new streaming endpoint with a {@link Duplex} configured for
   * object mode. The writable side delegates to {@link onWrite}; the readable
   * side is application-driven via explicit `duplex.push()` calls.
   */
  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const endpoint = this;
    this.duplex = new Duplex({
      objectMode: true,
      allowHalfOpen: true,
      autoDestroy: true,
      emitClose: true,
      /**
       * Invoked when the writable side of the stream ends (client
       * has called `.end()`). Delegates to {@link close}.
       */
      final: (cb: StreamWriteCallback) => {
        this.close().finally(cb);
      },

      /**
       * Read implementation is unused; server pushes responses
       * explicitly with `duplex.push()`.
       */
      read(size: number): void {
        endpoint.onRead(size);
      },

      /**
       * Handles a write from the client. Delegates to
       * {@link onWrite}, wrapping synchronous and asynchronous
       * errors into a {@link GoogleError}.
       *
       * @param chunk The value written by the client.
       * @param _encoding Encoding hint (ignored in object mode).
       * @param callback Completion callback (error-first).
       */
      write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: StreamWriteCallback
      ): void {
        function onError(e: unknown) {
          let error = e;
          if (!(e instanceof GoogleError)) {
            error = googleError(
              Status.INTERNAL,
              'Internal error on stream write.'
            );
          }
          callback(error as Error);
        }
        try {
          endpoint
            .onWrite(chunk as TRequest)
            .then(() => callback())
            .catch(onError);
        } catch (e) {
          // onWrite **may** throw synchronously
          onError(e);
        }
      },
    });
    const cleanup = (): void => {
      this.close();
    };

    this.duplex.on('close', cleanup);
    this.duplex.on('finish', cleanup);
    this.duplex.on('end', cleanup);
  }

  /**
   * Indicates whether this endpoint has been closed or aborted.
   */
  get isClosed(): boolean {
    return this._isClosed;
  }

  /**
   * Executes a synchronous operation and optionally closes the stream
   * when it completes. Any thrown error will abort the stream.
   *
   * @param op Synchronous operation to execute.
   * @param autoclose If true, {@link close} is invoked after `op` completes.
   * @returns Nothing.
   */
  run(op: () => void, autoclose = false): void {
    try {
      op();
      if (autoclose) {
        this.close();
      }
    } catch (err) {
      this.abort(err as Error);
    }
  }

  /**
   * Schedules a synchronous operation on the microtask queue and optionally
   * closes the stream when it completes. Any thrown error will abort the stream.
   *
   * @param op Synchronous operation to execute in a microtask.
   * @param autoclose If true, {@link close} is invoked after `op` completes.
   * @returns Nothing.
   */
  runMicrotask(op: () => void, autoclose = false): void {
    queueMicrotask(() => {
      this.run(op, autoclose);
    });
  }

  /**
   * Executes an asynchronous operation and optionally closes the stream
   * when it resolves. A rejected promise will abort the stream.
   *
   * @param op Asynchronous operation to execute.
   * @param autoclose If true, {@link close} is invoked after `op` resolves.
   * @returns Nothing.
   */
  runPromise(op: () => Promise<unknown>, autoclose = false): void {
    try {
      op()
        .then(() => {
          if (autoclose) {
            this.close();
          }
        })
        .catch((err) => {
          this.abort(err);
        });
    } catch (err) {
      this.abort(err as Error);
    }
  }

  /**
   * Gracefully closes the readable side of the stream.
   *
   * Removes the endpoint from its owner collection (if any),
   * marks it closed, and asynchronously pushes `null` to signal
   * end-of-stream to the client.
   *
   * Safe to call multiple times.
   */
  close(): Promise<void> {
    if (this._isClosed) return Promise.resolve();

    return resolvePromise<void>(undefined).then(() => {
      if (!this._isClosed) {
        this._isClosed = true;
        this[OWNER]?.delete(this);
        this.duplex.push(null);
      }
    });
  }

  /**
   * Aborts the stream, tearing down both readable and writable
   * sides immediately.
   *
   * Removes the endpoint from its owner collection (if any),
   * marks it closed, and calls {@link Duplex.destroy}, optionally
   * with an error.
   *
   * @param err Optional error that caused the abort.
   */
  abort(err?: Error) {
    // this.close();
    // this.duplex.destroy(err);
    if (this._isClosed) return;
    this[OWNER]?.delete(this);
    this._isClosed = true;
    this.duplex.destroy(err); // ends readable & writable; emits 'close'
  }

  /**
   * Hook invoked when the readable side requests more data.
   * Defaults to a no-op; subclasses may override to react to
   * backpressure or demand.
   *
   * @param size Suggested number of bytes to read (ignored in object mode).
   * @returns Nothing.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onRead(size: number): void {
    // no-op
  }

  /**
   * Subclasses must implement request handling logic for data written
   * by the client. Any thrown or rejected error will be wrapped into
   * a {@link GoogleError}.
   *
   * @param request The request object written by the client.
   * @returns A promise that resolves when the request has been processed.
   */
  protected abstract onWrite(request: TRequest): Promise<unknown>;
}

/**
 * A {@link StreamEndpoint} that ignores all writes and never emits
 * any responses. Useful for tests that only exercise stream lifecycle.
 */
export class NoOpStreamEndpoint extends StreamEndpoint<unknown> {
  protected override onWrite(): Promise<unknown> {
    return Promise.resolve();
  }
}
