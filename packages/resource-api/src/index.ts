/**
 * @stigmer/resource-api — proto-first resource API pipeline.
 *
 * TypeScript edition of the Stigmer request-pipeline commons (Java:
 * stigmer-cloud/backend/libs/java/grpc/grpc-request; Go:
 * stigmer/backend/libs/go/grpc/request/pipeline), restoring the two
 * capabilities the Go edition dropped (authorize, publish) and adding a
 * compile-time operation declaration (`defineResource`).
 *
 * Postgres-specific pieces (store adapter, migration runner) live under
 * `@stigmer/resource-api/postgres`.
 */

// Envelope
export type { Actor, ResourceMessage, ResourceMetadata } from "./envelope.js";
export { ActorSchema, ResourceMetadataSchema } from "./envelope.js";

// Identity & errors
export type { CallerPrincipal } from "./principal.js";
export { SYSTEM_PRINCIPAL } from "./principal.js";
export {
  alreadyExists,
  failedPrecondition,
  internal,
  invalidArgument,
  notFound,
  permissionDenied,
  unauthenticated,
} from "./errors.js";

// Authorization
export type {
  AuthorizationDecision,
  AuthorizationPolicy,
  AuthorizationRequest,
} from "./policy.js";
export { ALLOW, allowAnyAuthenticated, deny } from "./policy.js";

// Events
export type {
  ResourceEvent,
  ResourceEventHandler,
  ResourceEventPublisher,
} from "./publisher.js";
export { InProcessEventDispatcher, NOOP_PUBLISHER } from "./publisher.js";

// Store port + in-memory implementation
export type {
  FilterValue,
  ListQuery,
  ListResult,
  NormalizedFilter,
  RangeBound,
  ResourceStore,
} from "./store/store.js";
export { DuplicateNaturalKeyError, normalizeFilterValue } from "./store/store.js";
export type { MemoryKindConfig } from "./store/memory-store.js";
export { MemoryResourceStore } from "./store/memory-store.js";

// Pipeline & steps (the extension seam for domain steps)
export type { PipelineStep, StepTrait } from "./pipeline.js";
export { Pipeline } from "./pipeline.js";
export type { ResourceReference } from "./references.js";
export { referencesExistStep } from "./references.js";

// Resource definition & operations
export type {
  CallerExtractor,
  CreateOperationOptions,
  CustomContext,
  CustomOperationOptions,
  DefinedResource,
  GetOperationOptions,
  Invokable,
  InvokerFor,
  ListOperationOptions,
  OperationBinding,
  ReadContext,
  ResourceDefinition,
  ResourceInvoker,
  ResourceRef,
  UpdateOperationOptions,
  WriteContext,
} from "./resource.js";
export {
  buildMessage,
  createOperation,
  customOperation,
  DEFAULT_PAGE_SIZE,
  defineResource,
  getOperation,
  listOperation,
  MAX_PAGE_SIZE,
  updateOperation,
} from "./resource.js";

// Misc
export { generateResourceId } from "./id.js";
export { validateMessage } from "./validate.js";
