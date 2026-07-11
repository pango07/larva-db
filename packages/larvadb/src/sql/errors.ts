/**
 * Machine-readable SQL errors (Design §2, §7). Agents self-correct from
 * specific errors, so every rejection names what was attempted, why it is
 * unavailable, and what to do instead.
 */
export class SqlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SqlError";
  }
}

/** The catalog of deliberate v1 exclusions, keyed by the feature's keyword. */
export const UNSUPPORTED: Record<string, string> = {
  UNION: "UNION is not supported in Larva v1; run the queries separately and concatenate in application code",
  INTERSECT: "INTERSECT is not supported in Larva v1; run the queries separately and intersect in application code",
  EXCEPT: "EXCEPT is not supported in Larva v1; run the queries separately and subtract in application code",
  OVER: "window functions are not supported in Larva v1; compute windows in application code — tables at this scale fit in memory",
  VIEW: "views are not supported in Larva v1; wrap the query in an application function instead",
  TRIGGER: "triggers are not supported in Larva v1; perform follow-up writes in application code, inside db.transaction",
  INDEX: "secondary indexes are not supported in Larva v1; declare .partitionBy() on the column you filter most, or let small tables scan",
};

export const unsupported = (feature: string): SqlError =>
  new SqlError("UNSUPPORTED_FEATURE", UNSUPPORTED[feature] ?? `${feature} is not supported in Larva v1`);
