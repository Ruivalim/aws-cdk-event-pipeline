# aws-cdk-event-pipeline

An event ingestion pipeline on AWS, defined in TypeScript with the AWS CDK.

The interesting part of a queue is not the queue: it is what happens when the
consumer is wrong, slow, or dead. This is the shape that survives those three
cases: a dead-letter queue that outlives the main one, idempotent processing so
at-least-once delivery is safe, partial batch failure reporting so one bad
record does not replay a batch, and an alarm on backlog age, which is the
failure a function-level metric cannot see.

<!-- The badge renders once the repository is public. -->

[![CI](https://github.com/Ruivalim/aws-cdk-event-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/Ruivalim/aws-cdk-event-pipeline/actions/workflows/ci.yml)

## Architecture

```
        POST /                            ┌──── the failure path ────┐
          │                               │                          │
          ▼                               │                          ▼
  ┌───────────────┐                ┌──────┴──────┐            ┌───────────┐
  │ Function URL  │                │             │            │    DLQ    │
  │  (public)     │                │             │            │  retry 5x │
  └───────┬───────┘                │             │            └───────────┘
          │                        │             │                  ▲
          ▼                        │             │                  │
  ┌───────────────┐    enqueue     │    poll     │    fail 5x       │
  │   producer    │───────────────▶│  SQS queue  │──────────────────┘
  │  Lambda arm64 │                │             │
  └───────┬───────┘                └──────┬──────┘
          │                               │
          │ 202 + eventId                 │ batch of 10,
          │                               │ partial failures reported
          ▼                               ▼
  ┌───────────────┐                ┌───────────────┐
  │    caller     │                │    worker     │
  └───────────────┘                │  Lambda arm64 │
                                   └───────┬───────┘
                                           │ conditional PutItem
                                           ▼
                            ┌──────────────────────────────┐
                            │  DynamoDB (on-demand, TTL)   │
                            │  EVENT#<id> · TYPE#<type>    │
                            └──────────────────────────────┘

  CloudWatch: errors, throttles, dead-letter backlog, and backlog age
              + dashboard (queue depth, oldest message, invocations)
```

Two stacks, deliberately:

| Stack                            | Owns                                                | Why separate                                                                            |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `event-pipeline-ingest-*`        | Function URL, producer, queue, worker, events table | The pipeline. Replaced freely.                                                          |
| `event-pipeline-observability-*` | Alarms, topic, dashboard                            | Alarms can be changed during an incident without redeploying the thing that is on fire. |

## API

### `POST /` (Lambda Function URL)

```bash
curl -X POST "$FUNCTION_URL" \
  -H 'content-type: application/json' \
  -d '{"type":"order.created","payload":{"id":42,"total":1999}}'
```

```json
{ "eventId": "6f1d1f9c-0f5a-4a1e-9d3c-2f6a1b8e4c77", "type": "order.created" }
```

`202` when the event is durably enqueued. That status is the contract: it tells
the caller the event will not be lost if it stops worrying about it, which is
what makes a caller-side retry safe. A `5xx` means it was not ingested, so
retrying cannot duplicate anything.

`type` must look like `domain.action`: lowercase, dot-separated, at most 128
characters. `payload` is an optional object, at most 256 KB serialized (the SQS
message limit). `400` on anything else.

## Running it

Requires Node 24 (see `.nvmrc`) and no AWS account to build or test.

```bash
npm ci
npm run check        # formatting, lint, compile, 74 tests
npx cdk synth -c environment=dev
```

### Deploying

Deploy is documented rather than automated, because it needs credentials and a
bootstrap that belong to whoever owns the account.

```bash
npx cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

export CDK_TARGET_ACCOUNT=<ACCOUNT_ID>
export CDK_TARGET_REGION=us-east-1
npx cdk deploy --all -c environment=dev

# Optional: get an email when an alarm fires.
export ALARM_EMAIL=you@example.com
```

Tear everything down with `npx cdk destroy --all -c environment=dev`.

The account is opt-in on purpose: binding the stack to `CDK_DEFAULT_ACCOUNT`,
which the CDK CLI fills in from whatever profile is active, makes the stack
environment-specific and forces a live availability-zone lookup at synth time.
That needs credentials and breaks `cdk synth` in CI.

## Layout

```
bin/app.ts                       entry point: environments, stacks, tags
lib/constructs/
  lambda-function.ts               NodejsFunction with the house defaults
  reliable-queue.ts                SQS + dead-letter queue, with the invariant
  events-table.ts                  events table, idempotency key and type index
lib/stacks/
  ingest-stack.ts                  the pipeline and every grant
  observability-stack.ts           alarms, topic, dashboard
src/handlers/producer.ts         accepts and enqueues
src/handlers/worker.ts           consumes, records, reports partial failures
src/lib/                         validation, key layout, message parsing, clients
test/                            template assertions, invariants, handler tests
```

## Design decisions

**The dead-letter queue is not optional, and it must outlive the main queue.**
`ReliableQueue` refuses to build a dead-letter queue with a shorter retention
than the queue it protects, and throws at synth time if you try. A dead-letter
queue that expires first discards exactly the messages you need to debug.

**At-least-once delivery is handled, not assumed away.** SQS delivers a message
at least once, so the same event _will_ arrive twice eventually. The worker's
write is conditional on the event not existing, and a duplicate is logged and
treated as success. Reporting it as a failure would send it back to the queue,
where it would fail the same way until it landed in the dead-letter queue.

**Partial batch failure reporting.** The worker returns `batchItemFailures`
instead of throwing. Throwing returns the whole batch to the queue and
re-delivers the events that already succeeded. Reporting only the failed message
ids means one bad record costs one retry, not a batch.

**A backlog-age alarm, not just error alarms.** A worker that has stopped
polling produces zero errors and a growing queue. Error metrics read as healthy
while events pile up. `ApproximateAgeOfOldestMessage` is the only metric that
catches it, so it is the alarm that matters most here.

**Function URL instead of API Gateway.** The endpoint accepts one shape of
document: no routing, no authorizers, no usage plans. That is exactly the case
API Gateway charges $1 per million requests for and adds nothing to. If a second
route or an authorizer appears, the URL is the thing to replace.

**Nothing sends 200 when it means 202.** The producer returns `202` because
nothing has been processed yet. The distinction is what lets a caller retry a
`5xx` safely without risking a duplicate.

**IAM is scoped and tested.** The test suite asserts the split per function:
the producer can send but not receive, the worker can receive but not send, and
the worker can write events but not read them back. A separate test fails if any
policy statement gains a wildcard resource, except for the two X-Ray actions
that do not support resource-level permissions.

## Known limitations

These are real and worth naming rather than hiding:

- **The ingestion endpoint has no authentication.** `AuthType: NONE` because the
  intended caller has no IAM identity. Anyone who knows the URL can post events.
  A Lambda authorizer or an API key belongs in front of it before real traffic.
- **The worker does no real work.** It records the event and stops. It exists to
  make the delivery guarantees observable and testable; swap `processEvent` for
  the actual business logic.
- **Standard queue, so no ordering.** Events of the same type can be processed
  out of order. If ordering matters, this needs a FIFO queue with a message
  group per entity, and the idempotency story changes with it.
- **No DLQ redrive tooling.** Messages land in the dead-letter queue and the
  alarm fires, but replaying them is a manual `aws sqs` operation. A redrive
  path with a small CLI would be the next thing to build.

## Cost

At portfolio traffic this runs at effectively zero:

| Resource           | Cost                                                         |
| ------------------ | ------------------------------------------------------------ |
| Lambda             | Free tier covers 1M requests and 400k GB-s                   |
| Function URL       | No charge for the endpoint itself                            |
| DynamoDB on-demand | $1.25 per million writes, $0.25 per million reads            |
| SQS                | $0.40 per million requests                                   |
| CloudWatch logs    | The only unavoidable line. Two-week retention keeps it small |

The alarms and the dashboard are free under the 10-alarm and 3-dashboard tiers.

## License

MIT
