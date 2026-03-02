import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IngestStack } from '../lib/stacks/ingest-stack';
import { ObservabilityStack } from '../lib/stacks/observability-stack';

/**
 * Synthesizes the whole app and asserts on the observability stack.
 *
 * The alarm wiring cannot be tested in isolation: the alarms exist to watch
 * the pipeline, so a stack without it would assert nothing meaningful.
 */
function synth(alarmEmail?: string): Template {
  const app = new App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const environment = 'dev';

  const ingest = new IngestStack(app, 'test-ingest', { environment, env });

  const observability = new ObservabilityStack(app, 'test-observability', {
    environment,
    env,
    functions: [
      { label: 'producer', fn: ingest.producerFn.fn },
      { label: 'worker', fn: ingest.workerFn.fn },
    ],
    queue: ingest.queue.queue,
    deadLetterQueue: ingest.queue.deadLetterQueue,
    alarmEmail,
  });

  return Template.fromStack(observability);
}

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

function resourcesOfType(template: Template, type: string): CfnResource[] {
  const resources = template.toJSON().Resources as Record<string, CfnResource>;
  return Object.values(resources).filter((resource) => resource.Type === type);
}

describe('ObservabilityStack', () => {
  test('creates two alarms per function, plus the queue alarms', () => {
    // 2 functions x (errors + throttles) + dead-letter backlog + backlog age.
    synth().resourceCountIs('AWS::CloudWatch::Alarm', 6);
  });

  test('names each alarm after the environment and the thing it watches', () => {
    const template = synth();

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'event-pipeline-dev-worker-errors',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'event-pipeline-dev-producer-throttles',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'event-pipeline-dev-dlq-not-empty',
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'event-pipeline-dev-backlog-age',
    });
  });

  test('alarms on backlog age, not only on errors', () => {
    // The failure this exists for: a worker that stopped polling produces zero
    // errors and a growing queue. Every other metric reads as healthy.
    synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'event-pipeline-dev-backlog-age',
      Threshold: 300,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  test('never treats missing data as a breach', () => {
    const alarms = resourcesOfType(synth(), 'AWS::CloudWatch::Alarm');

    expect(alarms).toHaveLength(6);
    for (const alarm of alarms) {
      expect(alarm.Properties?.TreatMissingData).toBe('notBreaching');
    }
  });

  test('every alarm notifies the topic', () => {
    // An alarm with no action is a dashboard decoration.
    const alarms = resourcesOfType(synth(), 'AWS::CloudWatch::Alarm');
    const withoutActions = alarms.filter((alarm) => {
      const actions = alarm.Properties?.AlarmActions;
      return !Array.isArray(actions) || actions.length === 0;
    });

    expect(withoutActions).toEqual([]);
  });

  test('creates the alarm topic per environment', () => {
    const template = synth();

    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'event-pipeline-alarms-dev',
    });
  });

  test('creates the dashboard per environment', () => {
    const template = synth();

    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'event-pipeline-dev',
    });
  });

  test('subscribes the alarm address when one is given', () => {
    synth('ops@example.com').hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
  });

  test('creates no subscription when no address is given', () => {
    // Deliberate: the alarms and the topic exist, but nobody is told until an
    // address is configured. That is a decision, not an oversight.
    synth().resourceCountIs('AWS::SNS::Subscription', 0);
  });
});
