/**
 * Parsing and validation of an ingested event.
 *
 * Separated from the handler so the rules can be tested directly, without
 * standing up a Lambda invocation for every edge case.
 */

/** Longest accepted event type. It becomes part of a DynamoDB key. */
export const MAX_TYPE_LENGTH = 128;

/** Largest serialized payload accepted, in bytes. */
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/** Event types are `domain.action`, lowercase, dot-separated. */
const TYPE_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

export interface EventInput {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export type ValidationResult =
  | { readonly ok: true; readonly event: EventInput }
  | { readonly ok: false; readonly message: string };

/**
 * Validates an ingested event.
 *
 * The type is restricted to a `domain.action` shape rather than accepted as
 * free text. It is used as a DynamoDB key and as the dimension an operator
 * groups by, so an unconstrained string lets a producer poison the index with
 * a value nobody anticipated.
 */
export function validateEvent(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const { type, payload } = body as { type?: unknown; payload?: unknown };

  if (typeof type !== 'string' || type.length === 0) {
    return { ok: false, message: 'Field "type" is required and must be a string.' };
  }

  if (type.length > MAX_TYPE_LENGTH) {
    return { ok: false, message: `Field "type" must be at most ${MAX_TYPE_LENGTH} characters.` };
  }

  if (!TYPE_PATTERN.test(type)) {
    return {
      ok: false,
      message: 'Field "type" must look like "domain.action" (lowercase, dot-separated).',
    };
  }

  if (payload !== undefined && (typeof payload !== 'object' || payload === null)) {
    return { ok: false, message: 'Field "payload" must be an object when present.' };
  }

  const resolvedPayload = (payload ?? {}) as Record<string, unknown>;

  // Measured on the serialized form, because that is what travels through SQS
  // (256 KB hard limit) and what lands in the item.
  if (Buffer.byteLength(JSON.stringify(resolvedPayload), 'utf8') > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      message: `Field "payload" must serialize to at most ${MAX_PAYLOAD_BYTES} bytes.`,
    };
  }

  return { ok: true, event: { type, payload: resolvedPayload } };
}
