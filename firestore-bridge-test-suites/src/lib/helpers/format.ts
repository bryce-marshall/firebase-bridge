/**
 * Formats the given word as plural conditionally given the preceding number.
 *
 * @private
 * @internal
 * @param num The number to use for formatting.
 * @param str The string to format.
 */
export function formatPlural(num: number, str: string): string {
  return `${num} ${str}` + (num === 1 ? '' : 's');
}
