// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DocumentFieldValue = any;

export type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};

export const DEFAULT_PROJECT_ID = 'default-project';

export const DEFAULT_LOCATION = 'nam5';

export const DEFAULT_NAMESPACE = '(default)';
