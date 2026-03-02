import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/handlers/producer';
import { jsonBodyOf, postEvent } from '../helpers/events';

const sqsMock = mockClient(SQSClient);

const QUEUE_URL = 'https://sqs.sa-east-1.amazonaws.com/111111111111/event-ingest-test';

beforeEach(() => {
  sqsMock.reset();
  process.env.QUEUE_URL = QUEUE_URL;
  sqsMock.on(SendMessageCommand).resolves({ MessageId: 'message-id' });
});

afterAll(() => {
  delete process.env.QUEUE_URL;
});

describe('producer handler', () => {
  test('returns 400 for a body that is not JSON', async () => {
    const response = await handler(postEvent('{ not json'));

    expect(response.statusCode).toBe(400);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'invalid_json' });
    expect(sqsMock.calls()).toHaveLength(0);
  });

  test('returns 400 for an invalid event and enqueues nothing', async () => {
    const response = await handler(postEvent({ type: 'Not A Type' }));

    expect(response.statusCode).toBe(400);
    expect(jsonBodyOf(response)).toMatchObject({ error: 'invalid_request' });
    expect(sqsMock.calls()).toHaveLength(0);
  });

  test('returns 202 with an event id, not 200', async () => {
    // The status is the contract: 202 means "accepted for processing", which
    // is what makes a caller-side retry safe. 200 would imply it was done.
    const response = await handler(postEvent({ type: 'order.created', payload: { id: 1 } }));

    expect(response.statusCode).toBe(202);

    const body = jsonBodyOf(response);

    expect(body.type).toBe('order.created');
    expect(String(body.eventId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('enqueues the event as a self-describing message', async () => {
    await handler(postEvent({ type: 'order.created', payload: { id: 1 } }));

    const sends = sqsMock.commandCalls(SendMessageCommand);
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0].input.QueueUrl).toBe(QUEUE_URL);

    const message = JSON.parse(String(sends[0].args[0].input.MessageBody)) as Record<
      string,
      unknown
    >;

    expect(message).toMatchObject({ type: 'order.created', payload: { id: 1 } });
    expect(typeof message.eventId).toBe('string');
    expect(Number.isNaN(Date.parse(String(message.receivedAt)))).toBe(false);
  });

  test('gives each event a distinct id', async () => {
    await handler(postEvent({ type: 'order.created' }));
    await handler(postEvent({ type: 'order.created' }));

    const sends = sqsMock.commandCalls(SendMessageCommand);
    const first = JSON.parse(String(sends[0].args[0].input.MessageBody)) as { eventId: string };
    const second = JSON.parse(String(sends[1].args[0].input.MessageBody)) as { eventId: string };

    expect(first.eventId).not.toBe(second.eventId);
  });

  test('propagates an SQS failure instead of reporting a false accept', async () => {
    // Returning 202 while the enqueue failed would tell the caller to forget
    // the event. The failure has to surface so the caller retries.
    sqsMock.on(SendMessageCommand).rejects(new Error('SQS unavailable'));

    await expect(handler(postEvent({ type: 'order.created' }))).rejects.toThrow('SQS unavailable');
  });
});
