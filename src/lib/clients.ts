import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';

/**
 * Clients are created once, at module scope, and reused across invocations.
 * Creating them inside the handler is the classic Lambda mistake: every warm
 * invocation would rebuild the connection pool and re-resolve credentials.
 */

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {
    // Without this, an undefined optional field makes PutItem throw rather
    // than storing nothing, which turns "no owner id" into a 500.
    removeUndefinedValues: true,
  },
});

export const sqs = new SQSClient({});

/**
 * Reads a required environment variable.
 *
 * Called lazily rather than at module load so a missing variable fails the
 * invocation with a clear message instead of breaking the module import in
 * places that never needed it (tests, for one).
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
