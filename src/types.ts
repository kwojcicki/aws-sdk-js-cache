import type { MetadataBearer } from "@smithy/types";

/**
 * The extra input fields injected by the caching layer.
 *
 * `cacheKey` - a stable string key used to store/retrieve the response in the
 *              cache. When absent the middleware passes the request through
 *              without caching.
 */
export interface CacheInputExtension {
  cacheKey?: string;
}

/**
 * Wraps an existing AWS SDK v3 Command class so that its constructor `input`
 * is extended with the optional `cacheKey` field understood by the caching
 * middleware, while preserving the original instance type.
 *
 * @template TInput    - The command's input shape (e.g. `GetObjectCommandInput`).
 * @template TOutput   - The command's output shape (e.g. `GetObjectCommandOutput`).
 *
 * @example
 * ```ts
 * import { GetObjectCommand, GetObjectCommandInput, GetObjectCommandOutput } from "@aws-sdk/client-s3";
 * import type { CachableCommand } from "./types";
 *
 * type CachableGetObject = CachableCommand<GetObjectCommandInput, GetObjectCommandOutput>;
 *
 * // Cast the real command constructor to the cachable variant:
 * const CachableGetObjectCommand = GetObjectCommand as unknown as CachableGetObject;
 *
 * const cmd = new CachableGetObjectCommand({
 *   Bucket: "my-bucket",
 *   Key:    "my-key",
 *   cacheKey: "s3:my-bucket/my-key",   // <-- injected by this type
 * });
 * ```
 */
export type CachableCommand<
  TInput extends Record<string, unknown>,
  TOutput extends MetadataBearer
> = new (input: TInput & CacheInputExtension) => {
  readonly input: TInput & CacheInputExtension;
  readonly middlewareStack: unknown;
  resolveMiddleware(...args: unknown[]): unknown;
  readonly [Symbol.toStringTag]: string;
} & { output?: TOutput };
