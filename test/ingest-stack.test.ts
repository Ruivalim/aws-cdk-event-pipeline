import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ReliableQueue } from '../lib/constructs/reliable-queue';
import { IngestStack } from '../lib/stacks/ingest-stack';

/**
 * Builds an IngestStack in isolation. Tests never synth the real app: that
 * would couple them to every stack in `bin/app.ts` and make the failure output
 * useless.
 */
function synth(environment: 'dev' | 'prod' = 'dev'): Template {
  const app = new App();
  const stack = new IngestStack(app, `test-ingest-${environment}`, {
    environment,
    env: { account: '111111111111', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
}

interface IamStatement {
  Action?: unknown;
  Resource?: unknown;
}

type ResourceMap = Record<string, CfnResource>;

function resourceMap(template: Template): ResourceMap {
  return template.toJSON().Resources as ResourceMap;
}

function resourcesOfType(template: Template, type: string): CfnResource[] {
  return Object.values(resourceMap(template)).filter((resource) => resource.Type === type);
}

function iamStatements(template: Template): IamStatement[] {
  return resourcesOfType(template, 'AWS::IAM::Policy').flatMap((policy) => {
    const document = policy.Properties?.PolicyDocument as
      { Statement?: IamStatement[] } | undefined;
    return document?.Statement ?? [];
  });
}

function actionsOf(statement: IamStatement): string[] {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  return actions.filter((action): action is string => typeof action === 'string');
}

/** The logical id of the role a function runs as. */
function roleLogicalId(function_: CfnResource): string | undefined {
  const role = function_.Properties?.Role as { 'Fn::GetAtt'?: [string, string] } | undefined;
  return role?.['Fn::GetAtt']?.[0];
}

/**
 * Every IAM action the named function can perform.
 *
 * Resolves function to role to inline policy, so an assertion can be about one
 * function's permissions rather than the union of all of them, which is what
 * hides a privilege that leaked onto the wrong function.
 */
function actionsForFunction(template: Template, functionName: string): string[] {
  const resources = resourceMap(template);

  const target = Object.values(resources).find(
    (resource) =>
      resource.Type === 'AWS::Lambda::Function' &&
      resource.Properties?.FunctionName === functionName,
  );

  if (!target) {
    throw new Error(`No function named ${functionName} in the template.`);
  }

  const roleId = roleLogicalId(target);
  if (!roleId) {
    throw new Error(`Function ${functionName} has no role.`);
  }

  return Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::IAM::Policy')
    .filter((policy) => {
      const roles = policy.Properties?.Roles as Array<{ Ref?: string }> | undefined;
      return (roles ?? []).some((role) => role.Ref === roleId);
    })
    .flatMap((policy) => {
      const document = policy.Properties?.PolicyDocument as
        { Statement?: IamStatement[] } | undefined;
      return (document?.Statement ?? []).flatMap(actionsOf);
    });
}

describe('IngestStack queue', () => {
  test('creates the main queue and its dead-letter queue', () => {
    const template = synth();

    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'event-ingest-dev' });
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: 'event-ingest-dev-dlq' });
  });

  test('routes messages to the dead-letter queue after maxReceiveCount', () => {
    synth().hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'event-ingest-dev',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  test('gives production more retries than dev', () => {
    synth('prod').hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'event-ingest-prod',
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  test('keeps production messages for two weeks and dev for one', () => {
    expect(JSON.stringify(synth('prod').toJSON())).toContain('1209600');
    expect(JSON.stringify(synth('dev').toJSON())).toContain('604800');
  });

  test('requires TLS on both queues', () => {
    // enforceSSL: true materialises as a queue policy per queue.
    synth().resourceCountIs('AWS::SQS::QueuePolicy', 2);
  });

  test('never creates a queue without a dead-letter queue', () => {
    const queues = resourcesOfType(synth(), 'AWS::SQS::Queue');

    const withoutDlq = queues.filter(
      (queue) =>
        queue.Properties?.RedrivePolicy === undefined &&
        queue.Properties?.QueueName !== 'event-ingest-dev-dlq',
    );

    expect(withoutDlq).toEqual([]);
  });
});

describe('IngestStack pipeline', () => {
  test('creates the producer, the worker and the events table', () => {
    const template = synth();

    template.resourceCountIs('AWS::Lambda::Function', 2);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });

  test('names the functions per environment', () => {
    const template = synth();

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'event-producer-dev',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'event-worker-dev',
    });
  });

  test('exposes the producer through a function URL', () => {
    const template = synth();

    template.resourceCountIs('AWS::Lambda::Url', 1);
    // NONE is deliberate for an ingestion endpoint with no IAM caller, and it
    // is called out as a limitation in the README. If this changes to AWS_IAM
    // without that being intended, this test is the tripwire.
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
  });

  test('runs every function on arm64 with tracing enabled', () => {
    const functions = resourcesOfType(synth(), 'AWS::Lambda::Function');

    expect(functions).toHaveLength(2);

    for (const fn of functions) {
      expect(fn.Properties?.Architectures).toEqual(['arm64']);
      expect(fn.Properties?.Runtime).toBe('nodejs24.x');
      expect(fn.Properties?.TracingConfig).toEqual({ Mode: 'Active' });
    }
  });

  test('gives every function a log group with a retention', () => {
    synth().resourceCountIs('AWS::Logs::LogGroup', 2);
    synth().hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  test('indexes the events table by type', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: [
            { AttributeName: 'gsi1pk', KeyType: 'HASH' },
            { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  test('expires stored events through the TTL attribute', () => {
    synth().hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  test('wires the worker with partial batch failure reporting', () => {
    // Without ReportBatchItemFailures the handler's batchItemFailures return
    // value is ignored and any failure replays the whole batch.
    const template = synth();

    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BatchSize: 10,
    });
  });

  test('lets the producer send to the queue but not consume from it', () => {
    const actions = actionsForFunction(synth(), 'event-producer-dev');

    expect(actions).toContain('sqs:SendMessage');
    expect(actions).not.toContain('sqs:ReceiveMessage');
    expect(actions).not.toContain('sqs:DeleteMessage');
  });

  test('lets the worker consume from the queue but not publish to it', () => {
    const actions = actionsForFunction(synth(), 'event-worker-dev');

    expect(actions).toContain('sqs:ReceiveMessage');
    expect(actions).toContain('sqs:DeleteMessage');
    expect(actions).not.toContain('sqs:SendMessage');
  });

  test('lets the worker write events but not read them back', () => {
    // It records what it processed and never needs to query. Read access on
    // the worker would be a privilege with no consumer.
    const actions = actionsForFunction(synth(), 'event-worker-dev');

    const dynamo = actions.filter((action) => action.startsWith('dynamodb:'));

    expect(dynamo).toContain('dynamodb:PutItem');
    expect(dynamo).not.toContain('dynamodb:GetItem');
    expect(dynamo).not.toContain('dynamodb:Query');
  });

  test('gives each function its own role', () => {
    const roleRefs = resourcesOfType(synth(), 'AWS::Lambda::Function').map(roleLogicalId);

    expect(roleRefs).toHaveLength(2);
    expect(new Set(roleRefs).size).toBe(2);
  });

  test('scopes every resource, except where AWS does not support scoping', () => {
    // X-Ray's PutTraceSegments and PutTelemetryRecords do not accept
    // resource-level permissions, so `*` there is required rather than a
    // finding. Every other wildcard is a real one.
    const unscopable = new Set(['xray:PutTraceSegments', 'xray:PutTelemetryRecords']);
    const offenders: string[][] = [];

    for (const statement of iamStatements(synth())) {
      const resources = Array.isArray(statement.Resource)
        ? statement.Resource
        : [statement.Resource];
      if (!resources.includes('*')) {
        continue;
      }

      const unexpected = actionsOf(statement).filter((action) => !unscopable.has(action));
      if (unexpected.length > 0) {
        offenders.push(unexpected);
      }
    }

    expect(offenders).toEqual([]);
  });

  test('grants no wildcard dynamodb action', () => {
    const broadDynamo = iamStatements(synth())
      .flatMap(actionsOf)
      .filter((action) => action.startsWith('dynamodb:') && action.includes('*'));

    expect(broadDynamo).toEqual([]);
  });
});

describe('ReliableQueue invariants', () => {
  function queueIn(props: Partial<ConstructorParameters<typeof ReliableQueue>[2]>): void {
    const app = new App();
    const stack = new Stack(app, 'test-stack');
    new ReliableQueue(stack, 'Queue', { queueName: 'test-queue', ...props });
  }

  test('rejects a dead-letter queue that expires sooner than the main queue', () => {
    expect(() =>
      queueIn({ retentionPeriod: Duration.days(14), deadLetterRetentionPeriod: Duration.days(1) }),
    ).toThrow(/deadLetterRetentionPeriod/);
  });

  test('accepts a dead-letter queue with the same retention as the main queue', () => {
    expect(() =>
      queueIn({ retentionPeriod: Duration.days(7), deadLetterRetentionPeriod: Duration.days(7) }),
    ).not.toThrow();
  });

  test('accepts a dead-letter queue that outlives the main queue', () => {
    expect(() =>
      queueIn({ retentionPeriod: Duration.days(7), deadLetterRetentionPeriod: Duration.days(14) }),
    ).not.toThrow();
  });
});
