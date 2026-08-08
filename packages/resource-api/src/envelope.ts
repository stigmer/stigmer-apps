/**
 * The structural envelope contract. Consumers generate their own TypeScript
 * from their protos (with `include_imports`), producing their own copy of
 * the ResourceMetadata type — structurally identical to ours because it
 * comes from the same proto file, so cross-package assignability holds
 * without sharing generated code. The pipeline types against this shape and
 * never against any product's resource type.
 */

import type { Message } from "@bufbuild/protobuf";
import type { ResourceMetadata } from "./gen/stigmer/resourceapi/v1/resource_pb.js";

/**
 * Every resource served through the pipeline: api_version + kind + metadata
 * (system-managed) + spec/status (typed per resource, opaque to the
 * pipeline core — only app-provided extractors and the storage adapters
 * touch them).
 */
export type ResourceMessage = Message & {
  apiVersion: string;
  kind: string;
  metadata?: ResourceMetadata | undefined;
};

export type { Actor, ResourceMetadata } from "./gen/stigmer/resourceapi/v1/resource_pb.js";
export {
  ActorSchema,
  ResourceMetadataSchema,
} from "./gen/stigmer/resourceapi/v1/resource_pb.js";
