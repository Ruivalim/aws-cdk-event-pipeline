import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import path from 'node:path';
import type { Construct } from 'constructs';
import { EventsTable } from '../constructs/events-table';
import { LambdaFn } from '../constructs/lambda-function';
import { ReliableQueue } from '../constructs/reliable-queue';

const HANDLERS_DIR = path.join(__dirname, '..', '..', 'src', 'handlers');

export interface IngestStackProps extends StackProps {
  /** Environment name, used for resource naming (`dev`, `prod`). */
  readonly environment: string;
}

/**
 * The ingestion path: an HTTPS entry point, the queue, and the worker.
 *
 * A Lambda Function URL rather than API Gateway. The endpoint accepts one
 * shape of document, has no routing, no authorizers and no usage plans, which
 * is exactly the case API Gateway charges $1 per million requests for and adds
 * nothing to. If any of those appear later (a second route, an authorizer, a
 * usage plan), the URL is the thing to replace.
 */
export class IngestStack extends Stack {
  public readonly eventsTable: EventsTable;

  public readonly queue: ReliableQueue;

  public readonly producerFn: LambdaFn;

  public readonly workerFn: LambdaFn;

  constructor(scope: Construct, id: string, props: IngestStackProps) {
    super(scope, id, props);

    const { environment } = props;
    const isProduction = environment === 'prod';

    this.eventsTable = new EventsTable(this, 'Events', {
      tableName: `event-pipeline-events-${environment}`,
      // Production keeps a month of audit trail; dev keeps a week, because a
      // forgotten table is the one that grows unbounded.
      ttlDays: isProduction ? 30 : 7,
      destroyOnStackRemoval: !isProduction,
    });

    this.queue = new ReliableQueue(this, 'Ingest', {
      queueName: `event-ingest-${environment}`,
      // Fewer retries in dev: a poison message should surface during
      // development, not sit in a retry loop for minutes.
      maxReceiveCount: isProduction ? 5 : 3,
      // Production keeps two weeks of history so a late failure is still
      // diagnosable from the queue itself.
      retentionPeriod: isProduction ? Duration.days(14) : Duration.days(7),
      deadLetterRetentionPeriod: isProduction ? Duration.days(14) : Duration.days(7),
    });

    this.producerFn = new LambdaFn(this, 'Producer', {
      functionName: `event-producer-${environment}`,
      entry: path.join(HANDLERS_DIR, 'producer.ts'),
      environment: { QUEUE_URL: this.queue.queue.queueUrl },
      // The producer parses a small document and does one SendMessage. Ten
      // seconds is generous; five was already more than enough.
      timeout: Duration.seconds(5),
      memorySize: 256,
    });
    this.queue.grantSend(this.producerFn.fn);

    this.workerFn = new LambdaFn(this, 'Worker', {
      functionName: `event-worker-${environment}`,
      entry: path.join(HANDLERS_DIR, 'worker.ts'),
      environment: { TABLE_NAME: this.eventsTable.table.tableName },
      // Longer than the producer: this is where real processing happens, and
      // the queue's visibility timeout is sized against this value.
      timeout: Duration.seconds(30),
      memorySize: 512,
    });
    this.eventsTable.grantWrite(this.workerFn.fn);
    this.queue.grantConsume(this.workerFn.fn);

    this.workerFn.fn.addEventSource(
      new SqsEventSource(this.queue.queue, {
        batchSize: 10,
        // Without this, one malformed event would fail the whole batch and the
        // good events in it would be reprocessed.
        reportBatchItemFailures: true,
        maxBatchingWindow: Duration.seconds(5),
      }),
    );

    // Public by default and deliberately so: this is an ingestion endpoint
    // meant to be called by a producer that has no IAM identity. It is called
    // out in the README as the first thing to close before real traffic.
    this.producerFn.fn.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });
  }
}
