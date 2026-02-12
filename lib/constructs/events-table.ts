import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from 'aws-cdk-lib/aws-dynamodb';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Props for {@link EventsTable}.
 */
export interface EventsTableProps {
  /** Table name. CDK appends a unique suffix when this is left unset. */
  readonly tableName: string;

  /**
   * How long a processed event is kept, in days.
   *
   * @default 30
   */
  readonly ttlDays?: number;

  /**
   * Whether to delete the table with the stack.
   *
   * @default false
   */
  readonly destroyOnStackRemoval?: boolean;
}

/**
 * Where processed events are recorded.
 *
 * The table serves two purposes and they are worth naming separately:
 *
 * - **Idempotency.** The worker's write is conditional on the event not
 *   existing, so a redelivered message is a no-op instead of a duplicate. This
 *   is what makes at-least-once delivery safe to build on.
 * - **An audit trail.** "Did event X arrive, and when" is answered with a
 *   single GetItem, which is the question that matters when a producer claims
 *   it sent something.
 *
 * Access patterns:
 *
 * | Pattern                    | Key condition                            |
 * | -------------------------- | ---------------------------------------- |
 * | Fetch one event            | `pk = EVENT#<eventId>`                   |
 * | List events of one type    | `gsi1pk = TYPE#<type>`, newest first     |
 */
export class EventsTable extends Construct {
  /** The underlying table. Prefer the grant helpers below. */
  public readonly table: Table;

  /** Days after which a processed event expires. */
  public readonly ttlDays: number;

  constructor(scope: Construct, id: string, props: EventsTableProps) {
    super(scope, id);

    this.ttlDays = props.ttlDays ?? 30;

    this.table = new Table(this, 'Resource', {
      tableName: props.tableName,
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: props.destroyOnStackRemoval ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: AttributeType.STRING },
      // ALL rather than KEYS_ONLY: the type index exists to be read, and
      // projecting the payload costs nothing extra at write time here.
      projectionType: ProjectionType.ALL,
    });
  }

  /**
   * Grants the worker what it needs and nothing more: it writes records and
   * reads nothing back.
   */
  public grantWrite(grantee: IGrantable): void {
    this.table.grantWriteData(grantee);
  }

  /** Reads, for whatever operator tooling or a future query endpoint. */
  public grantRead(grantee: IGrantable): void {
    this.table.grantReadData(grantee);
  }

  /** Seconds until an event received *now* should expire. */
  public expirationSeconds(nowEpochSeconds: number): number {
    return nowEpochSeconds + Duration.days(this.ttlDays).toSeconds();
  }
}
