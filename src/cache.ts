/**
 * A minimal cache store interface. Any implementation that provides
 * synchronous or asynchronous get/set semantics satisfies this contract.
 *
 * @template V - The type of values stored in the cache.
 */
export interface CacheStore<V = unknown> {
  /**
   * Retrieve a cached value by key.
   * Returns `undefined` (or a Promise resolving to `undefined`) on a cache miss.
   */
  get(key: string): V | undefined | Promise<V | undefined>;

  /**
   * Store a value under the given key.
   */
  set(key: string, value: V): void | Promise<void>;
}
