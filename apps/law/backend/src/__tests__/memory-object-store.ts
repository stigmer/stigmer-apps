/**
 * Test-only in-memory ObjectStore for suites that never touch document
 * bytes (the server wiring requires one). The Document acceptance suite
 * does NOT use this — it runs real MinIO through the real S3 client, the
 * same configuration shape as production R2.
 */

import { Readable } from "node:stream";
import type { ObjectStore } from "../objectstore/object-store.js";

export function memoryObjectStore(): ObjectStore & { keys(): string[] } {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return undefined;
      return {
        body: Readable.from(Buffer.from(entry.body)),
        contentType: entry.contentType,
        contentLength: entry.body.byteLength,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    keys() {
      return [...objects.keys()];
    },
  };
}
