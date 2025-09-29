export function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

export function isObject(value: unknown): value is { [k: string]: unknown } {
  return Object.prototype.toString.call(value) === '[object Object]';
}

export function isPlainObject(input: unknown): boolean {
  return (
    isObject(input) &&
    (Object.getPrototypeOf(input) === Object.prototype ||
      Object.getPrototypeOf(input) === null ||
      input.constructor.name === 'Object')
  );
}
