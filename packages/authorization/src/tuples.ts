/**
 * Relationship tuples — the one data shape everything in this package
 * speaks. A tuple states "user has relation to object" in OpenFGA's
 * `type:id` reference form; apps build them from their own domain rows
 * and this package never interprets what the strings mean.
 */

export interface TupleKey {
  /** Principal reference, e.g. `user:u_123`. */
  readonly user: string;
  /** Relation name as declared in the model, e.g. `member`. */
  readonly relation: string;
  /** Object reference, e.g. `case:c_456`. */
  readonly object: string;
}

/** Build a `type:id` object/user reference. */
export function ref(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * The id half of a `type:id` reference. ListObjects answers full
 * references; store queries want raw ids.
 */
export function idOf(reference: string): string {
  const separator = reference.indexOf(":");
  return separator === -1 ? reference : reference.slice(separator + 1);
}

/** Canonical identity for set operations over tuples. */
export function tupleId(tuple: TupleKey): string {
  return `${tuple.user}|${tuple.relation}|${tuple.object}`;
}
