export type DataState = 'success' | 'partial' | 'failure' | 'stale';

export type StorageState = 'persisted' | 'saving' | 'memory-only' | 'failed';

export type RequestState = 'idle' | 'loading' | 'success' | 'error' | 'cancelled' | 'timeout';

export type ErrorKind =
  | 'network'
  | 'http'
  | 'decode'
  | 'invalid-data'
  | 'storage-unavailable'
  | 'quota'
  | 'timeout'
  | 'cancelled'
  | 'auth'
  | 'conflict';
