/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tiny utilities to read/write deeply nested values on plain JS objects using
 * a **segments array** path (e.g., `['a','b','c']`).
 *
 * Design notes:
 * - `getDeepValue` walks the object and returns `undefined` if an intermediate
 *   value is `null`/`undefined` or not an object.
 * - `setDeepValue` **mutates** the target object in-place. It **creates**
 *   intermediate objects as needed and **replaces** any non-object or `null`
 *   intermediate with a fresh plain object (`{}`) to allow the write.
 * - Arrays are treated as ordinary objects (no special handling). Passing
 *   `'0'` as a segment will access index `0` on an array.
 * - Paths must be provided as an array of keys; escaping/dot-parsing is not performed.
 */

/**
 * Safely retrieves a nested value from an object by walking a path of segments.
 *
 * If any intermediate value is `null`, `undefined`, or not an object,
 * the function stops and returns `undefined`.
 *
 * @param obj - The root object to read from. May be any value.
 * @param path - Array of property names to traverse (e.g., `['a','b','c']`).
 *               If empty, the function returns `obj` as-is.
 * @returns The found value, or `undefined` if the path is not fully present.
 *
 * @example
 * getDeepValue({ a: { b: 1 } }, ['a', 'b']); // → 1
 * getDeepValue({ a: null }, ['a', 'b']);     // → undefined
 * getDeepValue({ a: [ { x: 1 } ] }, ['a', '0', 'x']); // → 1
 */
export function getDeepValue(obj: any, path: string[]): unknown {
  let current = obj;
  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Sets a nested value on a plain object by walking a path of segments and
 * creating intermediate objects as needed.
 *
 * Semantics:
 * - Mutates `target` in-place.
 * - For each intermediate segment, if the current value is `undefined`,
 *   `null`, or not an object, it is **replaced** with a new plain object (`{}`).
 * - The final segment is assigned `value` (no cloning).
 * - Arrays are treated like objects; using `'0'` as a segment accesses index 0.
 *
 * ⚠️ **Preconditions**
 * - `path` must contain at least one segment. Passing an empty array is not
 *   supported and will attempt to set a property with the key `undefined`.
 *
 * @param target - The object to mutate. Should be a plain object.
 * @param path - Array of property names to traverse (e.g., `['a','b','c']`).
 * @param value - The value to assign at the final path segment.
 *
 * @example
 * const obj: any = {};
 * setDeepValue(obj, ['a', 'b', 'c'], 42);
 * // obj === { a: { b: { c: 42 } } }
 *
 * @example
 * const obj: any = { a: 1 };
 * setDeepValue(obj, ['a', 'b'], 'x');
 * // intermediate `a` was non-object, replaced with {}:
 * // obj === { a: { b: 'x' } }
 *
 * @example
 * const obj: any = { items: [] };
 * setDeepValue(obj, ['items', '0', 'name'], 'alpha');
 * // obj.items[0] === { name: 'alpha' }
 */
export function setDeepValue(
  target: Record<string, any>,
  path: string[],
  value: unknown
): void {
  let current = target;
  const lastIdx =  path.length - 1;

  for (let i = 0; i < lastIdx; i++) {
    const segment = path[i];

    const existing = current[segment];
    if (
      existing === undefined ||
      typeof existing !== 'object' ||
      existing === null
    ) {
      current[segment] = {};
    }

    current = current[segment];
  }

  current[path[lastIdx]] = value;
}
