import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { ddb, requireEnv } from '../lib/clients';
import {
  expirationEpoch,
  parseEventMessage,
  type EventMessage,
  type EventRecord,
} from '../lib/events';
import { eventKey, typeIndexKeys } from '../lib/keys';

/**
 * How long a processed event is kept.
 *
 * The record exists to answer "did this event arrive, and when" and to make
 * reprocessing a no-op. Both questions have a short shelf life; keeping the
 * history forever is how an event table becomes the largest line on the bill.
 */
const EVENT_TTL_DAYS = 30;

function tableName(): string {
  return requireEnv('TABLE_NAME');
}

/**
 * SQS consumer that processes events.
 *
 * Returns `batchItemFailures` rather than throwing. Throwing would return the
 * whole batch to the queue and re-deliver the events that already succeeded;
 * reporting only the failed message ids means one bad record costs one retry,
 * not a batch. This only takes effect if the event source mapping is created
 * with `reportBatchItemFailures: true` (see the ingress stack).
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];

  await Promise.all(
    event.Records.map(async (record) => {
      try {
        await processEvent(record);
      } catch (error) {
        console.error('Failed to process event; returning message to the queue', {
          messageId: record.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        failures.push({ itemIdentifier: record.messageId });
      }
    }),
  );

  return { batchItemFailures: failures };
}

/**
 * Records one processed event.
 *
 * The write is conditional on the event not existing yet, which makes it
 * idempotent: SQS delivers at least once, so the same event *will* arrive twice
 * eventually. A duplicate is not an error, it is the expected case, and it is
 * swallowed rather than reported as a failure so the message is deleted
 * instead of retried forever.
 */
async function processEvent(record: SQSRecord): Promise<void> {
  const message = parseEventMessage(record.body);

  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName(),
        Item: eventRecord(message),
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      console.warn('Event already processed; duplicate delivery ignored', {
        eventId: message.eventId,
      });
      return;
    }
    throw error;
  }
}

/** Builds the stored record for an accepted event. */
function eventRecord(message: EventMessage): EventRecord {
  return {
    ...eventKey(message.eventId),
    ...typeIndexKeys(message.type, message.receivedAt),
    eventId: message.eventId,
    type: message.type,
    payload: message.payload,
    receivedAt: message.receivedAt,
    processedAt: new Date().toISOString(),
    expiresAt: expirationEpoch(EVENT_TTL_DAYS),
  };
}
