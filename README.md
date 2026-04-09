# cache_middleware

A TypeScript library that adds response caching to AWS SDK v3 clients via the SDK's built-in middleware stack. Attach it once to any client and opt individual commands into caching by providing a `cacheKey` on the command input.

## Features

- **Cache hit/miss** — returns cached responses immediately without making an HTTP request
- **Request deduplication** — concurrent calls with the same `cacheKey` share a single in-flight request
- **Transparent passthrough** — commands without a `cacheKey` are completely unaffected
- **Async-friendly** — `CacheStore` supports both synchronous and `async` backends (Map, Redis, DynamoDB, etc.)
- **Observability hooks** — optional `onHit` / `onMiss` callbacks for logging and metrics
- **Zero runtime AWS SDK dependency** — works with any AWS SDK v3 client

## Installation

```sh
npm install cache_middleware
```

## Quick Start

```ts
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { createCachingMiddleware } from "cache_middleware";
import type { CacheInputExtension } from "cache_middleware";

// 1. Create any store that satisfies CacheStore<V> — a plain Map works fine
const cache = new Map<string, GetObjectCommandOutput>();

// 2. Attach the middleware to your client
const s3 = new S3Client({ region: "us-east-1" });

s3.middlewareStack.use(
  createCachingMiddleware<GetObjectCommandOutput>({
    store: {
      get: (key) => cache.get(key),
      set: (key, value) => { cache.set(key, value); },
    },
    onHit:  (key) => console.log(`[CACHE HIT]  ${key}`),
    onMiss: (key) => console.log(`[CACHE MISS] ${key}`),
  })
);

// 3. Add cacheKey to a command input to opt into caching
const input = {
  Bucket: "my-bucket",
  Key: "my-object.json",
  cacheKey: "s3:my-bucket/my-object.json",  // ← opt-in field
} as Parameters<typeof GetObjectCommand>[0] & CacheInputExtension;

// First call → cache miss → makes HTTP request → stores response
const result1 = await s3.send(new GetObjectCommand(input));

// Second call → cache hit → returns immediately, no HTTP request
const result2 = await s3.send(new GetObjectCommand(input));

// Without cacheKey → always passes through, never cached
const result3 = await s3.send(
  new GetObjectCommand({ Bucket: "my-bucket", Key: "other-object.json" })
);
```

## API

### `createCachingMiddleware<V>(options)`

Creates a `Pluggable` to pass to `client.middlewareStack.use(...)`.

```ts
interface CachingMiddlewareOptions<V extends MetadataBearer> {
  store: CacheStore<V>;                        // required
  onHit?:  (key: string, value: V) => void;    // optional
  onMiss?: (key: string) => void;              // optional
}
```

### `CacheStore<V>`

The interface your cache backend must implement:

```ts
interface CacheStore<V = unknown> {
  get(key: string): V | undefined | Promise<V | undefined>;
  set(key: string, value: V): void | Promise<void>;
}
```

### `CacheInputExtension`

The extra field added to a command input to opt into caching:

```ts
interface CacheInputExtension {
  cacheKey?: string;
}
```

### `CachableCommand<TInput, TOutput>`

A constructor type helper for casting existing SDK command classes so TypeScript accepts `cacheKey` natively without an inline cast:

```ts
import type { CachableCommand } from "cache_middleware";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { GetObjectCommandInput, GetObjectCommandOutput } from "@aws-sdk/client-s3";

type CachableGetObject = CachableCommand<GetObjectCommandInput, GetObjectCommandOutput>;
const CachableGetObjectCommand = GetObjectCommand as unknown as CachableGetObject;

// cacheKey is now a first-class typed field — no cast needed at the call site
const cmd = new CachableGetObjectCommand({
  Bucket: "my-bucket",
  Key: "my-object.json",
  cacheKey: "s3:my-bucket/my-object.json",
});
```

## Using an Async Store (e.g. Redis)

```ts
import { createClient } from "redis";
import { S3Client } from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { createCachingMiddleware } from "cache_middleware";

const redis = createClient();
await redis.connect();

const s3 = new S3Client({ region: "us-east-1" });

s3.middlewareStack.use(
  createCachingMiddleware<GetObjectCommandOutput>({
    store: {
      get: async (key) => {
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) : undefined;
      },
      set: async (key, value) => {
        await redis.set(key, JSON.stringify(value), { EX: 300 }); // 5-minute TTL
      },
    },
  })
);
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:watch` | Watch mode compilation |
| `npm test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |
