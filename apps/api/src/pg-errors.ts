/** True when err is a PostgreSQL error with the given SQLSTATE (23505 unique, 23503 foreign key). */
export function isPgError(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}
