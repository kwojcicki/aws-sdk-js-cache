import type {
  InitializeHandler,
  InitializeHandlerArguments,
  InitializeHandlerOutput,
  InitializeMiddleware,
  MetadataBearer,
  Pluggable,
} from "@smithy/types";

import type { CacheStore } from "./cache";
import type { CacheInputExtension } from "./types";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CachingMiddlewareOptions<V extends MetadataBearer> {
  /**
   * The cache store used for lookups and writes.
   */
  store: CacheStore<V>;

  /**
   * Optional hook called on every cache hit.
   * Useful for logging / metrics.
   */
  onHit?: (key: string, value: V) => void;

  /**
   * Optional hook called on every cache miss.
   * Useful for logging / metrics.
   */
  onMiss?: (key: string) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Input shape that at minimum carries the optional `cacheKey`. */
type CachableInput = Record<string, unknown> & CacheInputExtension;

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates an AWS SDK v3 *initialize* middleware that short-circuits requests
 * with a known `cacheKey` by returning the cached response when available,
 * and populating the cache with the live response on a miss.
 *
 * Concurrent requests that share the same `cacheKey` are deduplicated: only
 * the first in-flight request reaches the HTTP handler; all subsequent
 * callers with the same key attach to the same pending promise and receive
 * the same result without making additional network calls.
 *
 * Attach the result to an SDK client via `client.middlewareStack.use(...)`.
 *
 * @example
 * ```ts
 * import { S3Client } from "@aws-sdk/client-s3";
 * import { createCachingMiddleware } from "./middleware";
 *
 * const cache = new Map<string, unknown>();
 * const s3 = new S3Client({});
 *
 * s3.middlewareStack.use(
 *   createCachingMiddleware({
 *     store: {
 *       get: (k) => cache.get(k),
 *       set: (k, v) => { cache.set(k, v); },
 *     },
 *   })
 * );
 * ```
 */
export function createCachingMiddleware<
  V extends MetadataBearer = MetadataBearer
>(options: CachingMiddlewareOptions<V>): Pluggable<CachableInput, V> {
  const { store, onHit, onMiss } = options;

  /**
   * In-flight request map.
   *
   * When a cache miss triggers a live request, the resulting promise is stored
   * here under the cacheKey. Any concurrent request for the same key finds
   * this promise and awaits it directly instead of making a second HTTP call.
   * The entry is removed as soon as the promise settles (success or error).
   */
  const inFlight = new Map<string, Promise<InitializeHandlerOutput<V>>>();

  /**
   * The actual middleware function.
   * It satisfies the `InitializeMiddleware<Input, Output>` signature expected
   * by the SDK's middleware stack.
   */
  const middleware: InitializeMiddleware<CachableInput, V> = (
    next: InitializeHandler<CachableInput, V>
  ) =>
    async (
      args: InitializeHandlerArguments<CachableInput>
    ): Promise<InitializeHandlerOutput<V>> => {
      const { cacheKey, ...forwardedInput } = args.input;

      // No cacheKey → pass through unchanged.
      if (cacheKey === undefined) {
        return next(args);
      }

      // --- cache hit ---
      const cached = await store.get(cacheKey);
      if (cached !== undefined) {
        onHit?.(cacheKey, cached);
        return { output: cached, response: undefined as unknown };
      }

      // --- deduplicate concurrent misses ---
      // If another request with the same key is already in-flight, attach to
      // its promise rather than firing a second HTTP call.
      const pending = inFlight.get(cacheKey);
      if (pending !== undefined) {
        return pending;
      }

      // --- cache miss: own the in-flight request ---
      onMiss?.(cacheKey);

      // Strip `cacheKey` before forwarding so downstream handlers receive a
      // clean input that matches the original command's expected shape.
      const request = next({
        ...args,
        input: forwardedInput as CachableInput,
      }).then(async (result) => {
        await store.set(cacheKey, result.output);
        return result;
      }).finally(() => {
        inFlight.delete(cacheKey);
      });

      inFlight.set(cacheKey, request);

      return request;
    };

  return {
    applyToStack: (stack) => {
      stack.add(middleware, {
        step: "initialize",
        name: "cachingMiddleware",
        // Run before any other initialize middleware so we can short-circuit
        // as early as possible.
        priority: "high",
      });
    },
  };
}
