import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * Response builders.
 *
 * Centralized so every handler returns the same content type and error shape,
 * and so a change to the error format is one edit rather than several.
 */

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** A JSON response. */
export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/**
 * An error response with a stable shape: `{ error, message }`.
 *
 * `error` is the machine-readable part; `message` is for a human. Clients
 * should branch on `error`, never on `message`.
 */
export function problem(
  statusCode: number,
  error: string,
  message: string,
): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, { error, message });
}
