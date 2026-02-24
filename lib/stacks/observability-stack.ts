import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/** A function to alarm on, with the label used in alarm and widget names. */
export interface ObservableFunction {
  readonly label: string;
  readonly fn: IFunction;
}

export interface ObservabilityStackProps extends StackProps {
  /** Environment name, used for resource naming (`dev`, `prod`). */
  readonly environment: string;

  /** Functions to alarm on. */
  readonly functions: ObservableFunction[];

  /** The queue being consumed. Its backlog is the health signal that matters. */
  readonly queue: IQueue;

  /** Where messages land after repeated failures. */
  readonly deadLetterQueue: IQueue;

  /**
   * How old the oldest unprocessed message may get before it is an incident.
   *
   * @default Duration.minutes(5)
   */
  readonly maxBacklogAge?: Duration;

  /**
   * Address to notify when an alarm fires.
   *
   * Without it the stack still creates the alarms and the topic, but nobody is
   * told. That is a deliberate default rather than a forgotten configuration.
   */
  readonly alarmEmail?: string;
}

/**
 * Alarms, a notification topic, and a dashboard.
 *
 * For an ingestion pipeline the two alarms that carry the weight are the
 * dead-letter queue and the backlog age. Errors on the functions catch a
 * broken deploy; those two catch the failure mode that a function-level metric
 * cannot see, which is messages arriving and nothing consuming them. A worker
 * that has stopped polling produces zero errors and a growing queue, and
 * "zero errors" reads as healthy everywhere except here.
 *
 * Every alarm uses `TreatMissingData.NOT_BREACHING`: a service nobody called in
 * the last five minutes has no metrics, and treating that as a breach pages
 * someone every quiet night.
 */
export class ObservabilityStack extends Stack {
  /** Where alarms are published. */
  public readonly alarmTopic: Topic;

  /** The dashboard URL, for a README or a runbook. */
  public readonly dashboardUrl: string;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    const { environment } = props;
    const maxBacklogAge = props.maxBacklogAge ?? Duration.minutes(5);

    this.alarmTopic = new Topic(this, 'AlarmTopic', {
      topicName: `event-pipeline-alarms-${environment}`,
      displayName: 'Event pipeline alarms',
    });

    if (props.alarmEmail) {
      this.alarmTopic.addSubscription(new EmailSubscription(props.alarmEmail));
    }

    const notify = new SnsAction(this.alarmTopic);

    for (const { label, fn } of props.functions) {
      const errors = new Alarm(this, `Errors${label}`, {
        alarmName: `event-pipeline-${environment}-${label}-errors`,
        alarmDescription: `${label} returned errors.`,
        metric: fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      errors.addAlarmAction(notify);

      const throttles = new Alarm(this, `Throttles${label}`, {
        alarmName: `event-pipeline-${environment}-${label}-throttles`,
        alarmDescription: `${label} is being throttled; concurrency or a quota needs attention.`,
        metric: fn.metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      throttles.addAlarmAction(notify);
    }

    const dlqBacklog = new Alarm(this, 'DeadLetterBacklog', {
      alarmName: `event-pipeline-${environment}-dlq-not-empty`,
      alarmDescription:
        'Events failed repeatedly and were moved to the dead-letter queue. They are not being processed and nobody is looking at them.',
      metric: props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    dlqBacklog.addAlarmAction(notify);

    const staleBacklog = new Alarm(this, 'StaleBacklog', {
      alarmName: `event-pipeline-${environment}-backlog-age`,
      alarmDescription:
        'The oldest unprocessed event is older than the threshold. The worker is behind or has stopped consuming.',
      metric: props.queue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: maxBacklogAge.toSeconds(),
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    staleBacklog.addAlarmAction(notify);

    const dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: `event-pipeline-${environment}`,
    });

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Queue depth',
        width: 12,
        left: [
          props.queue.metricApproximateNumberOfMessagesVisible(),
          props.deadLetterQueue.metricApproximateNumberOfMessagesVisible(),
        ],
      }),
      new GraphWidget({
        title: 'Age of oldest message (seconds)',
        width: 12,
        left: [props.queue.metricApproximateAgeOfOldestMessage()],
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Function errors',
        width: 12,
        left: props.functions.map(({ fn }) => fn.metricErrors()),
      }),
      new GraphWidget({
        title: 'Function invocations',
        width: 12,
        left: props.functions.map(({ fn }) => fn.metricInvocations()),
      }),
    );

    this.dashboardUrl = `https://${this.region}.console.aws.amazon.com/cloudwatch/home#dashboards:name=${dashboard.dashboardName}`;
  }
}
