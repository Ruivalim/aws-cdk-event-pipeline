import { MAX_PAYLOAD_BYTES, MAX_TYPE_LENGTH, validateEvent } from '../../src/lib/validation';

describe('validateEvent', () => {
  test('accepts a well-formed event', () => {
    const result = validateEvent({ type: 'order.created', payload: { id: 42 } });

    expect(result).toEqual({ ok: true, event: { type: 'order.created', payload: { id: 42 } } });
  });

  test('accepts an event with no payload', () => {
    const result = validateEvent({ type: 'order.created' });

    expect(result).toEqual({ ok: true, event: { type: 'order.created', payload: {} } });
  });

  test('accepts a multi-segment type', () => {
    expect(validateEvent({ type: 'billing.invoice.paid' }).ok).toBe(true);
  });

  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
    ['no dot', 'ordercreated'],
    ['uppercase', 'Order.Created'],
    ['leading dot', '.created'],
    ['trailing dot', 'order.'],
    ['spaces', 'order created'],
    ['slashes', '../etc/passwd'],
  ])('rejects a %s type', (_label, type) => {
    // The type becomes a DynamoDB key and the dimension an operator groups by,
    // so an unconstrained string lets a producer poison the index.
    const result = validateEvent({ type });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/type/);
  });

  test('rejects a type longer than the limit', () => {
    const type = `a.${'b'.repeat(MAX_TYPE_LENGTH)}`;

    const result = validateEvent({ type });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/at most/);
  });

  test('rejects a payload that is not an object', () => {
    expect(validateEvent({ type: 'order.created', payload: 'a string' }).ok).toBe(false);
    expect(validateEvent({ type: 'order.created', payload: 42 }).ok).toBe(false);
  });

  test('rejects a payload larger than the limit', () => {
    const payload = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES) };

    const result = validateEvent({ type: 'order.created', payload });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/bytes/);
  });

  test('measures the payload on its serialized form, not its key count', () => {
    // A payload just under the limit must pass, so the check cannot be
    // accidentally comparing to something else.
    const payload = { blob: 'x'.repeat(MAX_PAYLOAD_BYTES - 100) };

    expect(validateEvent({ type: 'order.created', payload }).ok).toBe(true);
  });

  test.each([[null], ['string'], [42], [[]], [undefined]])('rejects a %p body', (body) => {
    const result = validateEvent(body);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/JSON object/);
  });
});
