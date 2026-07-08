/** The larvadb public surface (Design §13) plus prototype internals for tests. */
export { larva, LarvaDb, LarvaSnapshot, LarvaTx, type LarvaOptions } from "./db";
export { defineSchema, t, SchemaError, type DatabaseSchema } from "./schema";
export { SqlError } from "./sql/errors";
export { ConflictError, type Row, type Scalar } from "./core";
