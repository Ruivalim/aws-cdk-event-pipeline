import { randomUUID } from 'node:crypto';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { requireEnv, sqs } from '../lib/clients';
import type { EventMessage } from '../lib/events';
import { json, problem } from '../lib/responses';
import { validateEvent } from '../lib/validation';

/** Reads config lazily so importing this module needs no environment. */
function queueUrl(): string {
  return requireEnv('QUEUE_URL');
}

/**
 * Accepts an event and enqueues it.
 *
 * Returns `202` with the `eventId`, not `200`: the request has been durably
 * accepted for processing, but no processing has happened yet. This is the
 * contract that lets the caller treat a `5xx` as "not ingested" and a `202` as
 * "safe to forget", which is what makes producer-side retries safe.
 *
 * The producer is deliberately thin. Everything that can fail for an
 * interesting reason (the destination, the retries, the dead-letter path)
 * belongs to the worker.
 */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.body) : undefined;
  } catch {
    return problem(400, 'invalid_json', 'Request body must be valid JSON.');
  }

  const validation = validateEvent(body);
  if (!validation.ok) {
    return problem(400, 'invalid_request', validation.message);
  }

  const message: EventMessage = {
    eventId: randomUUID(),
    type: validation.event.type,
    payload: validation.event.payload,
    receivedAt: new Date().toISOString(),
  };

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl(),
      MessageBody: JSON.stringify(message),
      // Content-based dedup is only available on FIFO queues; for a standard
      // queue this attribute carries no ordering guarantee and is left off on
      // purpose. Idempotency is enforced by the worker, on the eventId.
    }),
  );

  return json(202, { eventId: message.eventId, type: message.type });
}
