/** Small listener registry used by storage mock internals. */
export class Listeners<T> {
  private readonly listeners = new Map<symbol, (arg: T) => void>();

  /** Registers a listener and returns an unsubscribe function. */
  register(listener: (arg: T) => void): () => void {
    const key = Symbol();
    this.listeners.set(key, listener);
    return () => {
      this.listeners.delete(key);
    };
  }

  /** Delivers an argument to all currently registered listeners. */
  next(arg: T): void {
    for (const listener of [...this.listeners.values()]) {
      listener(arg);
    }
  }

  /** Removes all registered listeners. */
  clear(): void {
    this.listeners.clear();
  }
}
