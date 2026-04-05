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

      // --- cache miss ---
      onMiss?.(cacheKey);

      // Strip `cacheKey` before forwarding so downstream handlers receive a
      // clean input that matches the original command's expected shape.
      const result = await next({
        ...args,
        input: forwardedInput as CachableInput,
      });

      await store.set(cacheKey, result.output);

      return result;
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
