import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Props for {@link LambdaFn}.
 */
export interface LambdaFnProps {
  /**
   * Function name. Also used to name the log group, so the two never drift.
   *
   * CDK appends a unique suffix when this is left unset, so keep it short.
   */
  readonly functionName: string;

  /** Path to the handler source, relative to the project root. */
  readonly entry: string;

  /**
   * Exported handler name inside `entry`.
   *
   * @default 'handler'
   */
  readonly handler?: string;

  /** Environment variables. Additions here are the only config a handler sees. */
  readonly environment?: Record<string, string>;

  /**
   * @default Duration.seconds(10)
   */
  readonly timeout?: Duration;

  /**
   * @default 512
   */
  readonly memorySize?: number;

  /**
   * @default RetentionDays.TWO_WEEKS
   */
  readonly logRetention?: RetentionDays;
}

/**
 * A Lambda with the operational defaults this project standardizes on.
 *
 * The point of wrapping `NodejsFunction` is that four decisions are made once
 * instead of per function:
 *
 * - **arm64.** Cheaper per millisecond and usually faster. There is no reason
 *   to run x86 for this workload.
 * - **An explicit log group with a retention.** Without one, CDK creates a log
 *   group that never expires, and the bill for that arrives quietly, months
 *   later.
 * - **X-Ray tracing on.** A distributed trace is the difference between "the
 *   redirect is slow" and knowing which hop is slow.
 * - **`@aws-sdk/*` left out of the bundle.** The Lambda runtime ships the AWS
 *   SDK v3. Bundling it adds cold-start time to every invocation for no gain.
 */
export class LambdaFn extends Construct {
  /** The function. Attach integrations and grants to this. */
  public readonly fn: NodejsFunction;

  /** The function's log group. */
  public readonly logGroup: LogGroup;

  constructor(scope: Construct, id: string, props: LambdaFnProps) {
    super(scope, id);

    this.logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/lambda/${props.functionName}`,
      retention: props.logRetention ?? RetentionDays.TWO_WEEKS,
      // DESTROY, not the CDK default of RETAIN: the log group holds no state
      // and an orphaned one survives every `cdk destroy`. Switch to RETAIN if
      // you ever need logs to outlive the stack for compliance.
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.fn = new NodejsFunction(this, 'Function', {
      functionName: props.functionName,
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: props.timeout ?? Duration.seconds(10),
      memorySize: props.memorySize ?? 512,
      tracing: Tracing.ACTIVE,
      logGroup: this.logGroup,
      environment: {
        // Stack traces in CloudWatch point at the TypeScript line, not the
        // bundled one, as long as the source map is loaded.
        NODE_OPTIONS: '--enable-source-maps',
        ...props.environment,
      },
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node24',
        externalModules: ['@aws-sdk/*'],
      },
    });
  }
}
