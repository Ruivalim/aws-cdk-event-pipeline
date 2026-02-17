/**
 * Key construction for the events table.
 *
 * Every pattern the table serves is written down here, next to the index that
 * makes it possible, so the schema and the queries cannot drift apart.
 */

/** Sort key of an event's record. */
export const EVENT_SORT_KEY = 'META';

/** Primary key of an event. */
export function eventKey(eventId: string): { pk: string; sk: string } {
  return { pk: `EVENT#${eventId}`, sk: EVENT_SORT_KEY };
}

/**
 * Keys of the type index (`gsi1`), sorted by when the event was received.
 *
 * This is the index an operator actually uses: "show me everything of type X,
 * newest first" is the first question asked when a producer starts sending
 * something malformed.
 */
export function typeIndexKeys(
  type: string,
  receivedAt: string,
): { gsi1pk: string; gsi1sk: string } {
  return { gsi1pk: `TYPE#${type}`, gsi1sk: receivedAt };
}
