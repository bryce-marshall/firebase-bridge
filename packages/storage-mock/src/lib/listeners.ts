export class Listeners<T> {
  private readonly listeners = new Map<symbol, (arg: T) => void>();

  register(listener: (arg: T) => void): () => void {
    const key = Symbol();
    this.listeners.set(key, listener);
    return () => {
      this.listeners.delete(key);
    };
  }

  next(arg: T): void {
    for (const listener of [...this.listeners.values()]) {
      listener(arg);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
