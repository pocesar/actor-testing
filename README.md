# Apify actor testing

Test your actors and tasks with multiple inputs, and expected outputs, integrating with results checker

* [Features](#features)
* [Testing](#testing)
* [Expected consumption](#expected-consumption)
* [Reasoning](#reasoning)

## Features

By leveraging [Jasmine](https://jasmine.github.io), the extensible `expect` and Apify SDK, you can test tasks and actors,
and check for their output consistency and/or duplicates.

It goes well with [monitoring suit](https://apify.com/apify/monitoring) for running your production runs, but this actor should
be run in a scheduled manner for best results.

* You can run many tests in parallel or test them in series (as your account memory allows)
* You can run tests locally but accessing platform storage and actors
* Abstracts access to two other public actors:
  * [Results checker](https://apify.com/lukaskrivka/results-checker)
  * [Duplications checker](https://apify.com/lukaskrivka/duplications-checker)

## Testing

The testing interface is familiar with Jasmine BDD tests, but with Apify specific async matchers:

```js
({
    it,
    run,
    expectAsync,
    input, // Object containing the current input, you can access customData here
    describe, // describe subsections
    expect, // default Jasmine expect
    _, // lodash as a helper to traverse array items and objects
    moment // Moment.JS to help with dates and time math
    Apify // Apify SDK v2
    apifyClient // Apify client v2
}) => {

  // describe is not needed, but it's good to keep everything tidy
  describe('sub', () => {

    it('should have preconfigured task working', async () => {
        const myTaskResult = await run({
            // actorId: 'actor/from-store', // can use an actorId directly
            taskId: 'myuser/my-task-name',
            input: {
                some: 'extra input' // optional overrides
            },
            options: {
                timeout: 15000 // optional call options
            },
            name: 'should have preconfigured task working'
        });

        // sync assertions, not very useful, expections should have inside async assertions
        expect(myTaskResult.runId).not.toBeEmptyString();

        /**
         * Async assertions calls resources on the platform
         */

        // reads the OUTPUT key
        await expectAsync(myTaskResult).withOutput(async ({ contentType, value }) => {
            expect(contentType)
                // withContext give more information about of what you're testing
                .withContext(myTaskResult.format('Body should be utf-8 JSON'))
                .toEqual('application/json; charset=utf-8');

            expect(value).toEqual({ hello: 'world' }, myTaskResult.format('Output body'));
        });

        // reads any key, fails the test if not found
        await expectAsync(myTaskResult).withKeyValueStore(async ({ key, contentType, value }) => {
            expect(value).toEqual({ status: true });
        }, { keyName: 'INPUT' });

        // gets requestQueue information
        await expectAsync(myTaskResult).withRequestQueue(async ({
            // contains everything from RequestQueueInfo
            id, userId, createdAt,
            modifiedAt, accessedAt, expireAt,
            totalRequestCount, handledRequestCount, pendingRequestCount,
            actId, actRunId, hadMultipleClients
        }) => {
            expect(totalRequestCount).toBeGreaterThan(1);
        });

        // check log for errors
        await expectAsync(myTaskResult).withLog((log) => {
            expect(log).not.toContain('ReferenceError');
            expect(log).not.toContain('TypeError');
            expect(log).not.toContain('The function passed to Apify.main() threw an exception');
        });

        // Check for dataset consistency
        await expectAsync(myTaskResult).withChecker(({ runResult, output }) => {
            expect(output.badItemCount).toBe(0);
        }, {
            functionalChecker: () => ({
                myField: (field) => typeof field === 'string'
            })
        });

        // Check for duplicate items
        await expectAsync(myTaskResult).withDuplicates(({ runResult, output }) => {
            expect(output).toEqual({});
        }, {
            taskId: 'myTaskId'
        })
    });

  });
}
```

Supports all extra Jasmine matchers, including asymmetrical matchers from https://github.com/JamieMason/Jasmine-Matchers
To access `any` without the JS editor complaining on the platform, you need to use `global.any[asymmetricMatcher]`

The special `run` parameter gives you the hability to run your tasks or actors, and return an accessor for their resources:

```js
const result = await run({
  taskId: 'xxx',  // task either by id or using user/task-name
  actorId: 'xxx', // actor either by id or using user/actor-name
  input: {}       // custom input override
  options: {}     // specific memory, timeout options
  nonce: '1'      // additional nonce for tasks running with the same input and options
  name: 'run name'// give the run a name to be able to distinguish between them
});
```

The `run` is idempotent and will run the same tasks once per test, but you can specify the `nonce` to force running it everytime

The `run` function returns an object with standard API client run info with extra data:
```js
runResult = {
    runInput, // Actual input of the run with default fields filled
    maxResults, // Attempts at parsing maxResults or similar field from input (use runInput to do this yourself)
    data: {
        ...runInfo,
        taskId,
        actorName,
        taskName,
        name: run.name,
    }
```

## Matchers

Those async matchers are lazy and only evaluated when you use them. You should use the result from `run` function to run `expectAsync()` on.
They abstract many common platform API calls. All callbacks can be plain closures or async ones, they are awaited anyway.

You also have full access to the Apify variable inside your tests.

#### toHaveStatus(status: 'SUCCEEDED' | 'FAILED' | 'ABORTED' | 'TIMED-OUT')
Checks for the proper run status

#### withLog((logContent: string) => void)
Run expectations on the `logContent`

#### withDuplicates((result: { runResult: Object, output: Object }) => void, input?: Object)
Ensures that no duplicates are found. You can provide a `taskId` with a pre-configured task or you can
provide all the input manually according to the docs [here](https://apify.com/lukaskrivka/duplications-checker/input-schema)
By default, anything above 2 counted items are considered duplicates

Returns the `OUTPUT` of the run, containing an object like this:

```jsonc
{
  // the keys here mean all the values that were found on the target dataset
  "$$": {
    "count": 4,
    "originalIndexes": [
      0,
      12,
      13,
      15
    ],
    "outputIndexes": [
      9,
      10,
      11,
      13
    ]
  },
  "MISSING!": { // this means it's missing or null value
    "count": 8,
    "originalIndexes": [
      1,
      3,
      4,
      6,
      10,
      14,
      16,
      17
    ],
    "outputIndexes": [
      0,
      1,
      2,
      5,
      8,
      12,
      14,
      15
    ]
  },
  "$$$": {
    "count": 4,
    "originalIndexes": [
      2,
      5,
      7,
      8
    ],
    "outputIndexes": [
      3,
      4,
      6,
      7
    ]
  }
}
```

#### withChecker((result: { runResult: Object, output: Object }) => void, input: Object, options?: Object)

Input is required and you need at least a `taskId` parameter pointing to a
pre-configured results-checker task or you can pass everything to the input.
Check the docs [here](https://apify.com/lukaskrivka/results-checker/input-schema)

Options is the Apify.call/callTask options
Returns the `OUTPUT` of the run, containing an object like this:

```jsonc
  "totalItemCount": 17,
  "badItemCount": 0,
  "identificationFields": [],
  "badFields": {},
  "extraFields": {},
  "totalFieldCounts": {
    "categories": 17,
    "info": 17,
    "likes": 17,
    "messenger": 17,
    "posts": 17,
    "priceRange": 10,
    "title": 17,
    "pageUrl": 17,
    "address": 17,
    "awards": 17,
    "email": 15,
    "impressum": 17,
    "instagram": 2,
    "phone": 15,
    "products": 17,
    "transit": 4,
    "twitter": 1,
    "website": 16,
    "youtube": 0,
    "mission": 17,
    "overview": 17,
    "payment": 2,
    "checkins": 12,
    "#startedAt": 17,
    "verified": 0,
    "#url": 17,
    "#ref": 17,
    "reviews": 14,
    "#version": 17,
    "#finishedAt": 17
  },
  "badItems": "https://api.apify.com/v2/key-value-stores/_/records/BAD-ITEMS?disableRedirect=true"
```

#### withDataset((result: { dataset: Object, info: Object }) => void, options?: Object)

Returns dataset information and the items. Options can be optionally passed to limit the number of items returned,
using `unwind` parameter, or any other option that is available here: [Dataset getItems](https://docs.apify.com/apify-client-js#ApifyClient-datasets-getItems)

The dataset object contains:

```js
{
    items: [ [Object] ],
    total: 1,
    offset: 0,
    count: 1,
    limit: 999999999999
}
```

The info object contains:

```js
{
    id: '',
    userId: '',
    createdAt: 2020-12-05T18:44:45.041Z,
    modifiedAt: 2020-12-05T18:44:50.515Z,
    accessedAt: 2020-12-05T18:44:50.515Z,
    itemCount: 1,
    cleanItemCount: 1,
    actId: '',
    actRunId: '',
    stats: {
      uploadedBytes: 0,
      downloadedBytes: 0,
      deflatedBytes: 0,
      inflatedBytes: 21,
      s3PutCount: 0,
      s3GetCount: 0,
      s3DeleteCount: 0,
      readCount: 0,
      writeCount: 1
    }
}
```

N.B.: this method waits at least 12 seconds to be able to read from the remote storage and make sure
it's ready to be accessed after the task/actor has finished running using `run`

#### withOutput((output: { value: any, contentType: string }) => void)

Returns the `OUTPUT` key of the run. Can have any content type, check the contentType

#### withStatistics((stats: Object) => void, options?: { index: number = 0 })

Returns the `SDK_CRAWLER_STATISTICS_0` key of the run by default, unless provided with another index
in the options.

Returns an object like this:

```json
{
  "requestsFinished": 217,
  "requestsFailed": 99,
  "requestsRetries": 0,
  "requestsFailedPerMinute": 3,
  "requestsFinishedPerMinute": 8,
  "requestMinDurationMillis": 3071,
  "requestMaxDurationMillis": 41800,
  "requestTotalFailedDurationMillis": 686856,
  "requestTotalFinishedDurationMillis": 3161769,
  "crawlerStartedAt": "2020-12-07T05:06:44.107Z",
  "crawlerFinishedAt": null,
  "statsPersistedAt": "2020-12-07T05:34:04.209Z",
  "crawlerRuntimeMillis": 1640402,
  "crawlerLastStartTimestamp": 1607317603807,
  "requestRetryHistogram": [
    316
  ],
  "statsId": 0,
  "requestAvgFailedDurationMillis": 6938,
  "requestAvgFinishedDurationMillis": 14570,
  "requestTotalDurationMillis": 3848625,
  "requestsTotal": 316
}
```

#### withKeyValueStore((output: { value: any, contentType: string }) => void, options: { keyName: string })

Returns the content of the selected keyName. The test fails if the key doesn't exist.
You can access the INPUT that was used for the run using `{ keyName: 'INPUT' }`

#### withRequestQueue((requestQueue: Object) => void)

Access the requestQueue object, that contains:

```js
{
    id: '',
    userId: '',
    createdAt: 2020-12-05T18:44:45.048Z,
    modifiedAt: 2020-12-05T18:44:45.048Z,
    accessedAt: 2020-12-05T18:44:45.048Z,
    expireAt: 2021-02-03T18:44:45.048Z,
    totalRequestCount: 0,
    handledRequestCount: 0,
    pendingRequestCount: 0,
    actId: '',
    actRunId: '',
    hadMultipleClients: false
}
```

N.B.: all those exists only on `expectAsync` and need to be awaited, as demonstrated above:

```js
await expectAsync(runResult).withDataset((something) => {
    expect(something).toEqual('here');
});
```

`jasmine.any()` and `jasmine.anything()` can be accessed using `global.jasmine`

## Output

The tests output are available in the key value store under `OUTPUT` key, with the following structure:

```json
{
  "suite2": {
    "id": "suite2",
    "description": "one",
    "fullName": "Actor tests one",
    "failedExpectations": [],
    "deprecationWarnings": [],
    "duration": 26484,
    "properties": null,
    "status": "passed",
    "specs": [
      {
        "id": "spec0",
        "description": "should work",
        "fullName": "Actor tests one should work",
        "failedExpectations": [],
        "passedExpectations": [
          {
            "matcherName": "toHaveStatus",
            "message": "Passed.",
            "stack": "",
            "passed": true
          },
          {
            "matcherName": "toEqual",
            "message": "Passed.",
            "stack": "",
            "passed": true
          },
          {
            "matcherName": "withDataset",
            "message": "Passed.",
            "stack": "",
            "passed": true
          },
          {
            "matcherName": "withRequestQueue",
            "message": "Passed.",
            "stack": "",
            "passed": true
          },
          {
            "matcherName": "withOutput",
            "message": "Passed.",
            "stack": "",
            "passed": true
          },
          {
            "matcherName": "withKeyValueStore",
            "message": "Passed.",
            "stack": "",
            "passed": true
          },
          {
            "matcherName": "withChecker",
            "message": "Passed.",
            "stack": "",
            "passed": true
          }
        ],
        "deprecationWarnings": [],
        "pendingReason": "",
        "duration": 26480,
        "properties": null,
        "status": "passed"
      }
    ]
  },
  "suite3": {
    "id": "suite3",
    "description": "two",
    "fullName": "Actor tests two",
    "failedExpectations": [],
    "deprecationWarnings": [],
    "duration": 21,
    "properties": null,
    "status": "passed",
    "specs": [
      {
        "id": "spec1",
        "description": "works",
        "fullName": "Actor tests two works",
        "failedExpectations": [
          {
            "matcherName": "toBe",
            "message": "Expected true to be false.",
            "stack": "Error: Expected true to be false.\n    at <Jasmine>\n    at listOnTimeout (internal/timers.js:549:17)\n    at processTimers (internal/timers.js:492:7)",
            "passed": false,
            "expected": false,
            "actual": true
          }
        ],
        "passedExpectations": [],
        "deprecationWarnings": [],
        "pendingReason": "",
        "duration": 15,
        "properties": null,
        "status": "failed"
      }
    ]
  }
}
```

## Expected consumption

This is a very lightweight actor that only intermediates actor runs, it can be run with the lowest amount of memory, which is 128MB.
Running for an hour should consume around 0.125 CUs.

## Reasoning

Automated and integration tests are a must have for any complex piece of software. For Apify actors, it's no different.
Apify actors can be one (or many inputs) to one output, or it can have many items (through the dataset).

## License

Apache 2.0
