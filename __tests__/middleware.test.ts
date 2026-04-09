import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { GetObjectCommandInput, GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import type { Pluggable } from "@smithy/types";
import { createCachingMiddleware } from "../src/middleware";
import type { CacheStore } from "../src/cache";
import type { CacheInputExtension } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The minimal interface a fake HTTP handler must satisfy — mirrors
 * NodeHttpHandler's public API so it slots straight into S3Client's
 * `requestHandler` option.
 */
interface FakeHandler {
  handle: jest.Mock<
    Promise<{ response: HttpResponse }>,
    [HttpRequest, HttpHandlerOptions?]
  >;
  updateHttpClientConfig: (key: string, value: unknown) => void;
  httpHandlerConfigs: () => Record<string, unknown>;
}

/**
 * Builds a minimal S3 GetObject HTTP response. The SDK deserialises the body
 * lazily so for unit tests status 200 + headers is sufficient.
 */
function makeS3Response(bodyText: string): HttpResponse {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Readable } = require("stream") as typeof import("stream");
  return new HttpResponse({
    statusCode: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(Buffer.byteLength(bodyText)),
      "x-amz-request-id": "FAKEREQID",
    },
    body: Readable.from([Buffer.from(bodyText)]),
  });
}

/**
 * Creates a fake HTTP handler whose `handle` method is a jest spy.
 * Responses are consumed from the queue in order; the test fails loudly if
 * more calls are made than responses were enqueued.
 */
function makeFakeHandler(responses: HttpResponse[]): FakeHandler {
  return {
    handle: jest.fn(async (_req: HttpRequest, _opts?: HttpHandlerOptions) => {
      const response = responses.shift();
      if (!response) throw new Error("FakeHandler: no more responses queued");
      return { response };
    }),
    updateHttpClientConfig: () => {},
    httpHandlerConfigs: () => ({}),
  };
}

/**
 * In-memory CacheStore backed by a plain Map.
 * The internal map is exposed so tests can assert on stored entries directly.
 */
function makeMemoryStore<V>(): CacheStore<V> & { _map: Map<string, V> } {
  const _map = new Map<string, V>();
  return {
    _map,
    get: (key) => _map.get(key),
    set: (key, value) => {
      _map.set(key, value);
    },
  };
}

/**
 * Convenience: build an S3Client wired with `handler` and the caching
 * middleware already on the stack.
 *
 * The `as unknown as Pluggable<...>` cast is required because the SDK's
 * generic ServiceInputTypes is the union of *all* S3 command inputs, which
 * is wider than our CachableInput.  At runtime the middleware only reads
 * `input.cacheKey` and then strips it, so this is safe.
 */
function makeClient(
  handler: FakeHandler,
  store: CacheStore<GetObjectCommandOutput>
): S3Client {
  const client = new S3Client({
    region: "us-east-1",
    credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestHandler: handler as any,
  });

  client.middlewareStack.use(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createCachingMiddleware<GetObjectCommandOutput>({ store }) as unknown as Pluggable<any, any>
  );

  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCachingMiddleware", () => {
  // -------------------------------------------------------------------------
  // Cache miss → live request → populate cache
  // -------------------------------------------------------------------------
  describe("on a cache miss", () => {
    it("forwards the request to the HTTP handler exactly once", async () => {
      const handler = makeFakeHandler([makeS3Response("hello")]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const client = makeClient(handler, store);

      await client.send(
        new GetObjectCommand({
          Bucket: "my-bucket",
          Key: "my-key",
          cacheKey: "s3:my-bucket/my-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );

      expect(handler.handle).toHaveBeenCalledTimes(1);
    });

    it("stores the response in the cache under the provided cacheKey", async () => {
      const handler = makeFakeHandler([makeS3Response("hello")]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const client = makeClient(handler, store);

      await client.send(
        new GetObjectCommand({
          Bucket: "my-bucket",
          Key: "my-key",
          cacheKey: "s3:my-bucket/my-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );

      expect(store._map.has("s3:my-bucket/my-key")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Cache hit → no HTTP request
  // -------------------------------------------------------------------------
  describe("on a cache hit", () => {
    it("returns the cached value without calling the HTTP handler", async () => {
      const handler = makeFakeHandler([]); // no responses – any call would throw
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const client = makeClient(handler, store);

      const cachedOutput: GetObjectCommandOutput = {
        $metadata: { httpStatusCode: 200 },
        ContentType: "text/plain",
      };
      store._map.set("s3:my-bucket/my-key", cachedOutput);

      const result = await client.send(
        new GetObjectCommand({
          Bucket: "my-bucket",
          Key: "my-key",
          cacheKey: "s3:my-bucket/my-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );

      expect(handler.handle).not.toHaveBeenCalled();
      expect(result.ContentType).toBe("text/plain");
    });

    it("returns the exact object reference stored in the cache", async () => {
      const handler = makeFakeHandler([]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const client = makeClient(handler, store);

      const cachedOutput: GetObjectCommandOutput = {
        $metadata: { httpStatusCode: 200 },
        ContentType: "application/json",
      };
      store._map.set("the-key", cachedOutput);

      const result = await client.send(
        new GetObjectCommand({
          Bucket: "b",
          Key: "k",
          cacheKey: "the-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );

      expect(result).toBe(cachedOutput);
    });
  });

  // -------------------------------------------------------------------------
  // Repeated requests for the same key → one HTTP call total
  // -------------------------------------------------------------------------
  describe("across repeated requests for the same key", () => {
    it("only calls the HTTP handler once regardless of how many sends are made", async () => {
      const handler = makeFakeHandler([makeS3Response("data")]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const client = makeClient(handler, store);

      const input = {
        Bucket: "b",
        Key: "k",
        cacheKey: "b/k",
      } as GetObjectCommandInput & CacheInputExtension;

      await client.send(new GetObjectCommand(input)); // miss  → HTTP call
      await client.send(new GetObjectCommand(input)); // hit   → from cache
      await client.send(new GetObjectCommand(input)); // hit   → from cache

      expect(handler.handle).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // No cacheKey → middleware is fully transparent
  // -------------------------------------------------------------------------
  describe("when no cacheKey is provided", () => {
    it("passes every request through to the HTTP handler without caching", async () => {
      const handler = makeFakeHandler([
        makeS3Response("first"),
        makeS3Response("second"),
      ]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const client = makeClient(handler, store);

      const input: GetObjectCommandInput = { Bucket: "b", Key: "k" };

      await client.send(new GetObjectCommand(input));
      await client.send(new GetObjectCommand(input));

      expect(handler.handle).toHaveBeenCalledTimes(2);
      expect(store._map.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Observability hooks
  // -------------------------------------------------------------------------
  describe("observability hooks", () => {
    it("calls onMiss with the cacheKey on a cache miss", async () => {
      const handler = makeFakeHandler([makeS3Response("x")]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const onMiss = jest.fn();
      const client = new S3Client({
        region: "us-east-1",
        credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
        requestHandler: handler as unknown as never,
      });
      client.middlewareStack.use(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createCachingMiddleware<GetObjectCommandOutput>({ store, onMiss }) as unknown as Pluggable<any, any>
      );

      await client.send(
        new GetObjectCommand({
          Bucket: "b",
          Key: "k",
          cacheKey: "miss-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );

      expect(onMiss).toHaveBeenCalledTimes(1);
      expect(onMiss).toHaveBeenCalledWith("miss-key");
    });

    it("calls onHit with the key and cached value on a cache hit", async () => {
      const handler = makeFakeHandler([]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const onHit = jest.fn();
      const cachedOutput: GetObjectCommandOutput = { $metadata: { httpStatusCode: 200 } };
      store._map.set("hit-key", cachedOutput);

      const client = new S3Client({
        region: "us-east-1",
        credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
        requestHandler: handler as unknown as never,
      });
      client.middlewareStack.use(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createCachingMiddleware<GetObjectCommandOutput>({ store, onHit }) as unknown as Pluggable<any, any>
      );

      await client.send(
        new GetObjectCommand({
          Bucket: "b",
          Key: "k",
          cacheKey: "hit-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );

      expect(onHit).toHaveBeenCalledTimes(1);
      expect(onHit).toHaveBeenCalledWith("hit-key", cachedOutput);
    });

    it("does not call onHit on a miss or onMiss on a hit", async () => {
      const handler = makeFakeHandler([makeS3Response("y")]);
      const store = makeMemoryStore<GetObjectCommandOutput>();
      const onHit = jest.fn();
      const onMiss = jest.fn();

      const client = new S3Client({
        region: "us-east-1",
        credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
        requestHandler: handler as unknown as never,
      });
      client.middlewareStack.use(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createCachingMiddleware<GetObjectCommandOutput>({ store, onHit, onMiss }) as unknown as Pluggable<any, any>
      );

      // First send → miss
      await client.send(
        new GetObjectCommand({
          Bucket: "b", Key: "k", cacheKey: "some-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );
      expect(onHit).not.toHaveBeenCalled();
      expect(onMiss).toHaveBeenCalledTimes(1);

      onMiss.mockClear();

      // Second send → hit
      await client.send(
        new GetObjectCommand({
          Bucket: "b", Key: "k", cacheKey: "some-key",
        } as GetObjectCommandInput & CacheInputExtension)
      );
      expect(onMiss).not.toHaveBeenCalled();
      expect(onHit).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Async (Promise-based) cache store
  // -------------------------------------------------------------------------
  describe("with a Promise-based async cache store", () => {
    it("awaits async get/set and still short-circuits on a hit", async () => {
      const _map = new Map<string, GetObjectCommandOutput>();
      const asyncStore: CacheStore<GetObjectCommandOutput> = {
        get: (key) => Promise.resolve(_map.get(key)),
        set: (key, value) =>
          new Promise<void>((resolve) => {
            setTimeout(() => {
              _map.set(key, value);
              resolve();
            }, 0);
          }),
      };

      const handler = makeFakeHandler([makeS3Response("async-body")]);
      const client = new S3Client({
        region: "us-east-1",
        credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
        requestHandler: handler as unknown as never,
      });
      client.middlewareStack.use(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createCachingMiddleware<GetObjectCommandOutput>({ store: asyncStore }) as unknown as Pluggable<any, any>
      );

      const input = {
        Bucket: "b", Key: "k", cacheKey: "async-key",
      } as GetObjectCommandInput & CacheInputExtension;

      await client.send(new GetObjectCommand(input)); // miss → populates cache
      await client.send(new GetObjectCommand(input)); // hit  → no HTTP call

      expect(handler.handle).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent requests with the same cacheKey — deduplication
  // -------------------------------------------------------------------------
  describe("concurrent requests with the same cacheKey", () => {
    it("only calls the HTTP handler once when two sends are in-flight simultaneously", async () => {
      const _map = new Map<string, GetObjectCommandOutput>();
      const deferredStore: CacheStore<GetObjectCommandOutput> = {
        get: (key) => Promise.resolve(_map.get(key)),
        set: (key, value) => { _map.set(key, value); },
      };

      // Only one response queued — a second HTTP call would throw.
      const handler = makeFakeHandler([makeS3Response("response-1")]);

      const client = new S3Client({
        region: "us-east-1",
        credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
        requestHandler: handler as unknown as never,
      });
      client.middlewareStack.use(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createCachingMiddleware<GetObjectCommandOutput>({ store: deferredStore }) as unknown as Pluggable<any, any>
      );

      const input = {
        Bucket: "b", Key: "k", cacheKey: "race-key",
      } as GetObjectCommandInput & CacheInputExtension;

      // Fire both sends concurrently — the second must attach to the
      // in-flight promise rather than making its own HTTP call.
      const [result1, result2] = await Promise.all([
        client.send(new GetObjectCommand(input)),
        client.send(new GetObjectCommand(input)),
      ]);

      expect(handler.handle).toHaveBeenCalledTimes(1);
      // Both callers receive the same response object.
      expect(result1).toBe(result2);
    });

    it("calls onMiss only once for concurrent requests sharing a cacheKey", async () => {
      const _map = new Map<string, GetObjectCommandOutput>();
      const deferredStore: CacheStore<GetObjectCommandOutput> = {
        get: (key) => Promise.resolve(_map.get(key)),
        set: (key, value) => { _map.set(key, value); },
      };

      const handler = makeFakeHandler([makeS3Response("data")]);
      const onMiss = jest.fn();

      const client = new S3Client({
        region: "us-east-1",
        credentials: { accessKeyId: "FAKE", secretAccessKey: "FAKE" },
        requestHandler: handler as unknown as never,
      });
      client.middlewareStack.use(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createCachingMiddleware<GetObjectCommandOutput>({ store: deferredStore, onMiss }) as unknown as Pluggable<any, any>
      );

      const input = {
        Bucket: "b", Key: "k", cacheKey: "race-key",
      } as GetObjectCommandInput & CacheInputExtension;

      await Promise.all([
        client.send(new GetObjectCommand(input)),
        client.send(new GetObjectCommand(input)),
        client.send(new GetObjectCommand(input)),
      ]);

      expect(onMiss).toHaveBeenCalledTimes(1);
    });
  });
});
