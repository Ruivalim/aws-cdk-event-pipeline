import { Duration } from 'aws-cdk-lib';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

/**
 * Props for {@link ReliableQueue}.
 */
export interface ReliableQueueProps {
  /** Base name for both queues. The dead-letter queue gets a `-dlq` suffix. */
  readonly queueName: string;

  /**
   * Time a consumer has to process a message before it becomes visible again.
   *
   * Set this to at least the consumer's timeout. A visibility timeout shorter
   * than the processing time is the classic cause of duplicate delivery.
   *
   * @default Duration.seconds(30)
   */
  readonly visibilityTimeout?: Duration;

  /**
   * How many times a message may be received before it is moved to the
   * dead-letter queue.
   *
   * @default 5
   */
  readonly maxReceiveCount?: number;

  /**
   * How long successfully processed messages are kept in the main queue.
   *
   * @default Duration.days(14)
   */
  readonly retentionPeriod?: Duration;

  /**
   * How long failed messages are kept in the dead-letter queue.
   *
   * Must be greater than or equal to `retentionPeriod`: a dead-letter queue
   * that expires faster than the main queue silently discards exactly the
   * messages you need to debug. The constructor rejects that combination.
   *
   * @default Duration.days(14)
   */
  readonly deadLetterRetentionPeriod?: Duration;
}

/**
 * A queue that is safe to put production traffic through.
 *
 * Wraps the parts that are easy to get wrong and impossible to notice until an
 * incident: a dead-letter queue that outlives the main queue, SSL-only access,
 * and encryption at rest. The dead-letter queue is always created, never
 * optional; a queue without one turns poison messages into an infinite retry
 * loop that looks like healthy throughput.
 */
export class ReliableQueue extends Construct {
  /** The main queue. Producers send here. */
  public readonly queue: Queue;

  /** The dead-letter queue. Alarm on `approximateNumberOfMessagesVisible`. */
  public readonly deadLetterQueue: Queue;

  /** The receive count after which a message is routed to the DLQ. */
  public readonly maxReceiveCount: number;

  constructor(scope: Construct, id: string, props: ReliableQueueProps) {
    super(scope, id);

    const retentionPeriod = props.retentionPeriod ?? Duration.days(14);
    const deadLetterRetention = props.deadLetterRetentionPeriod ?? Duration.days(14);

    if (deadLetterRetention.toSeconds() < retentionPeriod.toSeconds()) {
      throw new Error(
        `deadLetterRetentionPeriod (${deadLetterRetention.toHumanString()}) must not be shorter than ` +
          `retentionPeriod (${retentionPeriod.toHumanString()}). Failed messages would expire in the ` +
          'dead-letter queue before anyone can inspect them.',
      );
    }

    this.maxReceiveCount = props.maxReceiveCount ?? 5;

    this.deadLetterQueue = new Queue(this, 'Dlq', {
      queueName: `${props.queueName}-dlq`,
      retentionPeriod: deadLetterRetention,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.queue = new Queue(this, 'Resource', {
      queueName: props.queueName,
      visibilityTimeout: props.visibilityTimeout ?? Duration.seconds(30),
      retentionPeriod,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.deadLetterQueue,
        maxReceiveCount: this.maxReceiveCount,
      },
    });
  }

  /** Allow a producer to enqueue messages. Does not grant any read access. */
  public grantSend(grantee: IGrantable): void {
    this.queue.grantSendMessages(grantee);
  }

  /**
   * Allow a worker to poll and delete messages, and to read the dead-letter
   * queue so it can report on failures.
   */
  public grantConsume(grantee: IGrantable): void {
    this.queue.grantConsumeMessages(grantee);
    this.deadLetterQueue.grantConsumeMessages(grantee);
  }
}
