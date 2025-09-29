export type Listener<T> = (value: T) => void;

export class Listeners<T> {
  private _listeners = new Set<Listener<T>>();

  register(listener: (value: T) => void) {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  next(value: T): void {
    for (const l of this._listeners.values()) {
      l(value);
    }
  }

  clear(): void {
    this._listeners.clear();
  }
}
