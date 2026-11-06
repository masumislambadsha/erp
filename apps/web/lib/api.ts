export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body:
      { message?: string; code?: string; issues?: { path: string; message: string }[] } | undefined,
  ) {
    super(body?.message ?? `request failed (${status})`);
  }
}

/** Calls the API through the same-origin /api rewrite. Writes carry the CSRF header and an Idempotency-Key. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (method !== 'GET') headers['x-erp-csrf'] = '1';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export const newKey = (): string => crypto.randomUUID();
