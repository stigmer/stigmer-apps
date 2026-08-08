/**
 * The object-store port: private bucket, S3 API. Production is a
 * Cloudflare R2 bucket consumed as plain S3 with an endpoint override
 * (DD-001 verified infrastructure fact); tests run MinIO the same way —
 * identical client configuration shape, so the tests exercise what
 * production runs.
 *
 * ALL access is backend-mediated (scope contract): nothing here ever
 * mints a client-facing bucket URL.
 */

import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface StoredObject {
  readonly body: Readable;
  readonly contentType?: string;
  readonly contentLength?: number;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Undefined when the key does not exist. */
  get(key: string): Promise<StoredObject | undefined>;
  /** Best-effort cleanup (idempotent — deleting a missing key is fine). */
  delete(key: string): Promise<void>;
}

export interface S3ObjectStoreConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Path-style addressing — required by MinIO, harmless for R2. */
  readonly forcePathStyle?: boolean;
}

export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle ?? true,
  });

  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },
    async get(key) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        );
        return {
          body: res.Body as Readable,
          contentType: res.ContentType,
          contentLength: res.ContentLength,
        };
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") {
          return undefined;
        }
        throw err;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },
  };
}
