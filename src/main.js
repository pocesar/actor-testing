const Apify = require('apify');
const Jasmine = require('jasmine');
const ApifyClient = require('apify-client');
const { SpecReporter, StacktraceOption } = require('jasmine-spec-reporter');
const vm = require('vm');
const _ = require('lodash');
const moment = require('moment');
const Loader = require('jasmine/lib/loader');
const { setupJasmine } = require('./matchers');
const setupRun = require('./run');
const JSONReporter = require('./collector');
const { collectFailed, nameBreak, createNotifier } = require('./common');

const { log } = Apify.utils;

Apify.main(async () => {
    /** @type {any} */
    const input = await Apify.getInput();

    const notify = createNotifier(input);

    const {
        defaultTimeout = 1200000,
        filter,
        verboseLogs = true,
        isAbortSignal = false,
        isTimeoutSignal = false,
        abortRuns = true,
    } = input;

    /** @type {string} */
    const token = input.token || Apify.getEnv().token;
    const client = new ApifyClient({
        token,
    });

    const defaultFilename = 'test.js';

    let testName = 'Actor tests';

    if (!input.testName) {
        const thisTaskId = Apify.getEnv().actorTaskId;
        if (thisTaskId) {
            const { name } = await client.task(thisTaskId).get();

            if (name) {
                testName = name;
            }
        }
    } else {
        testName = input.testName;
    }

    if (Apify.isAtHome()) {
        // we need to stop pending runs from the remote aborted/timed-out run
        if (isAbortSignal) {
            const remoteKv = await Apify.openKeyValueStore(input.kv);
            const calls = new Map(await remoteKv.getValue('CALLS'));
            for (const { runId } of calls.values()) {
                log.info(`Aborting run ${runId}`);
                await client.run(runId).abort();
            }
            return;
        }

        if (isTimeoutSignal) {
            await notify({
                slackMessage: `<https://my.apify.com/view/runs/${input.actorRunId}|${testName}> has timed out!`,
                emailMessage: `Your test <a href="https://my.apify.com/view/runs/${input.actorRunId}">${testName}</a> timed out`,
                subject: `${testName} has timed out!`,
            });

            return;
        }

        const { actorRunId, actorId, defaultKeyValueStoreId } = Apify.getEnv();

        if (abortRuns) {
            // dynamicly webhook ourselves so we can catch the CALLS from outside and abort them
            await Apify.addWebhook({
                eventTypes: ['ACTOR.RUN.ABORTED', 'ACTOR.RUN.TIMED_OUT', 'ACTOR.RUN.FAILED'],
                requestUrl: `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
                idempotencyKey: `ABORT-${actorRunId}`,
                payloadTemplate: JSON.stringify({
                    isAbortSignal: true,
                    token,
                    kv: defaultKeyValueStoreId,
                }),
            });
        }

        // notify timeouts separately
        await Apify.addWebhook({
            eventTypes: ['ACTOR.RUN.TIMED_OUT'],
            requestUrl: `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
            idempotencyKey: `TIMEOUT-${actorRunId}`,
            payloadTemplate: JSON.stringify({
                slackToken: input.slackToken,
                slackChannel: input.slackChannel,
                email: input.email,
                isTimeoutSignal: true,
                actorRunId,
                token,
            }),
        });
    }

    if (!input.testSpec) {
        throw new Error('Missing required input "testSpec" parameter');
    }

    // hacking jasmine internals to accept non-existing files
    const instance = new Jasmine({
        loader: new Loader({
            requireShim: (filename) => {
                if (filename === 'jasmine-expect') {
                    return require('jasmine-expect'); // eslint-disable-line
                }
                return Promise.resolve();
            },
        }),
    });

    instance.env.clearReporters();

    const specReporter = new SpecReporter({ // add jasmine-spec-reporter
        spec: {
            displaySuccessful: false,
            displayFailed: false,
            displayPending: false,
            displayDuration: true,
            displayStacktrace: StacktraceOption.NONE,
        },
        summary: {
            displayDuration: true,
            displayErrorMessages: true,
            displaySuccessful: verboseLogs,
            displayPending: verboseLogs,
            displayStacktrace: StacktraceOption.RAW,
            displayFailed: true,
        },
        stacktrace: {
            filter(stacktrace) {
                return stacktrace.split('\n').filter((line) => line.includes(`at ${defaultFilename}`)).join('\n');
            },
        },
    });

    instance.addReporter(specReporter);

    const jsonReporter = new JSONReporter(
        async (testResult) => {
            const { failed, total, totalSpecs, failedSpecs } = collectFailed(testResult);
            const { actorRunId, defaultKeyValueStoreId } = Apify.getEnv();

            await Apify.setValue('OUTPUT', testResult);
            const addName = nameBreak();

            const slackMessage = `<https://my.apify.com/view/runs/${actorRunId}|${testName}> has ${
                failed.length
            }/${total} failing expectations. Failing test suites: ${failedSpecs}/${totalSpecs}. Check the <https://api.apify.com/v2/key-value-stores/${
                defaultKeyValueStoreId
            }/records/OUTPUT?disableRedirect=true|OUTPUT> for full details.\n${failed.map((s) => `${addName(s.name, ':\n')}${s.markdown}`).join('\n')}`;

            const emailMessage = `Check the <a href="https://api.apify.com/v2/key-value-stores/${
                defaultKeyValueStoreId
            }/records/OUTPUT?disableRedirect=true">OUTPUT</a> for full details.<br>\n${failed.map((s) => `${addName(s.name, ':<br>')}${s.html}`).join('\n<br>\n')}`;

            if (input.debugMessages) {
                await Apify.pushData({
                    slackMessage,
                    emailMessage,
                });
            }

            if (failed.length) {
                await notify({
                    emailMessage,
                    slackMessage,
                    subject: `${testName} has failing ${failedSpecs} tests`,
                });
            }
        },
        verboseLogs,
    );

    instance.addReporter(jsonReporter);

    jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout;
    const runFn = await setupRun(Apify, client, verboseLogs);

    // jasmine executes everything as global, so we just eval it here
    ((context) => {
        const { describe, beforeAll } = context;

        describe(testName, () => {
            beforeAll(() => {
                setupJasmine(
                    instance,
                    client,
                    runFn,
                );
            });

            const script = new vm.Script(input.testSpec, {
                displayErrors: true,
                lineOffset: 0,
                filename: defaultFilename,
            });

            script.runInThisContext()({
                ...context,
                input: {
                    ...input,
                    customData: input.customData || {},
                },
                _,
                moment,
            });
        });
    })({
        ...instance.env,
        run: runFn,
    });

    instance.addSpecFile(defaultFilename);
    instance.helperFiles.push('jasmine-expect');
    instance.randomizeTests(false);
    instance.stopSpecOnExpectationFailure(false);

    await instance.execute(undefined, (filter || []).join('|') || undefined);
});
