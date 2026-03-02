import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { handler } from '../../src/handlers/worker';
import { sqsEvent } from '../helpers/events';

const ddbMock = mockClient(DynamoDBDocumentClient);

const TABLE = 'event-pipeline-events-test';

function messageBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: '6f1d1f9c-0f5a-4a1e-9d3c-2f6a1b8e4c77',
    type: 'order.created',
    payload: { id: 42 },
    receivedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

beforeEach(() => {
  ddbMock.reset();
  process.env.TABLE_NAME = TABLE;
  ddbMock.on(PutCommand).resolves({});
});

afterAll(() => {
  delete process.env.TABLE_NAME;
});

describe('worker handler', () => {
  test('processes an event and reports no failures', async () => {
    const result = await handler(sqsEvent([messageBody()]));

    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  test('stores the event under its id, with the type index keys', async () => {
    await handler(sqsEvent([messageBody()]));

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;

    expect(item?.pk).toBe('EVENT#6f1d1f9c-0f5a-4a1e-9d3c-2f6a1b8e4c77');
    expect(item?.sk).toBe('META');
    expect(item?.gsi1pk).toBe('TYPE#order.created');
    expect(item?.gsi1sk).toBe('2026-01-01T00:00:00.000Z');
    expect(item?.payload).toEqual({ id: 42 });
    expect(Number.isNaN(Date.parse(String(item?.processedAt)))).toBe(false);
  });

  test('makes the write conditional so a redelivery is a no-op', async () => {
    // SQS delivers at least once, so the same event *will* arrive twice. The
    // condition is what turns that from a duplicate into a no-op.
    await handler(sqsEvent([messageBody()]));

    const input = ddbMock.commandCalls(PutCommand)[0].args[0].input;

    expect(input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  test('treats a duplicate as success, not as a failure', async () => {
    // Reporting the duplicate as a failure would send it back to the queue,
    // where it would fail the same way until it landed in the dead-letter
    // queue. A duplicate is the expected case, not an error.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));

    const result = await handler(sqsEvent([messageBody()]));

    expect(result.batchItemFailures).toEqual([]);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test('sets a TTL on the stored event', async () => {
    await handler(sqsEvent([messageBody()]));

    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;

    expect(typeof item?.expiresAt).toBe('number');
    expect(Number(item?.expiresAt)).toBeGreaterThan(Math.floor(Date.now() / 1000) + 29 * 86_400);
  });

  test('processes a whole batch', async () => {
    const result = await handler(sqsEvent([messageBody(), messageBody(), messageBody()]));

    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(3);
  });

  test('reports only the failing message id, not the batch', async () => {
    // One bad record must not send the good ones back to be processed twice.
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    ddbMock.on(PutCommand).resolvesOnce({}).rejectsOnce(new Error('write failed')).resolvesOnce({});

    const result = await handler(sqsEvent([messageBody(), messageBody(), messageBody()]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-1' }]);

    consoleError.mockRestore();
  });

  test('reports a message whose body is not valid JSON', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await handler(sqsEvent(['{ not json']));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-0' }]);
    expect(ddbMock.calls()).toHaveLength(0);

    consoleError.mockRestore();
  });

  test.each([
    ['no eventId', messageBody({ eventId: undefined })],
    ['empty eventId', messageBody({ eventId: '' })],
    ['no type', messageBody({ type: undefined })],
    ['no receivedAt', messageBody({ receivedAt: undefined })],
    ['invalid receivedAt', messageBody({ receivedAt: 'not-a-date' })],
  ])('rejects a message with %s', async (_label, body) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await handler(sqsEvent([body]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-0' }]);
    expect(ddbMock.calls()).toHaveLength(0);

    consoleError.mockRestore();
  });

  test('defaults a missing payload to an empty object', async () => {
    const result = await handler(sqsEvent([messageBody({ payload: undefined })]));

    expect(result.batchItemFailures).toEqual([]);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item?.payload).toEqual({});
  });

  test('propagates a DynamoDB failure that is not a duplicate', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    ddbMock.on(PutCommand).rejects(new Error('throughput exceeded'));

    const result = await handler(sqsEvent([messageBody()]));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'message-0' }]);

    consoleError.mockRestore();
  });
});
