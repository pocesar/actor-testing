const Apify = require('apify');
const ApifyClient = require('apify-client'); // eslint-disable-line no-unused-vars
const Jasmine = require('jasmine'); // eslint-disable-line no-unused-vars
const common = require('./common'); // eslint-disable-line no-unused-vars

/**
 * Sleep configurable from the outside. Needs to wait for storages
 * to settle. Sleeps once, lazily
 */
const createSettlementSleep = () => {
    let didSleep = false;

    return async () => {
        if (!didSleep) {
            didSleep = true;
            await Apify.utils.sleep(+(process?.env?.DATASET_SLEEP_MS ?? 0));
        }
    };
};

const settlementSleep = createSettlementSleep();

/**
 * Make the comparision composable without boilerplate
 *
 * @param {(param: {
 *  result: common.Result,
 *  value: any,
 *  utils: { equals: (a: any, b: any) => boolean },
 *  client: ApifyClient,
 *  args: any[],
 *  runFn: common.Runner,
 *  format: (message: string) => string
 * }) => Promise<{ pass: boolean, message?: string }>} compare
 */
const generateCompare = (compare) => (/** @type {ApifyClient} */client, /** @type {common.Runner} */runFn) => (utils) => ({
    /**
     * @param {common.Result} result
     * @param {any} value
     * @param {any[]} args
     */
    async compare(result, value, ...args) {
        if (!common.isRunResult(result)) {
            throw new Error('Invalid usage of expectAsync on non-run result. Did you forget to run()?');
        }

        return compare({
            result,
            value,
            args,
            utils,
            client,
            runFn,
            format: common.formatRunMessage(result),
        });
    },
});

/**
 * toString() a function if given as a parameter, or return itself
 * @param {string|Function} fn
 */
const stringifyFn = (fn) => (typeof fn === 'function' ? fn.toString() : fn);

/**
 * @param {{
 *   value: (args: any) => Promise<void>,
 *   args: any,
 *   format: (message: string) => string,
 * }} params
 */
const callbackValue = async ({ value, args, format }) => {
    try {
        await value(args);

        return {
            pass: true,
        };
    } catch (e) {
        return {
            pass: false,
            message: format(e.message),
        };
    }
};

/**
 * Always return an object while consuming the item
 * on the provided array
 *
 * @param {any[]} args
 */
const safeOptions = (args) => args.shift() || {};

const toHaveStatus = generateCompare(async ({ result, value, utils, client, format }) => {
    const run = await client.run(result.runId).get();

    return {
        pass: utils.equals(run.status, value),
        message: format(`Expected status to be "${value}", got "${run.status}"`),
    };
});

/**
 * Retrieve the run log
 */
const withLog = generateCompare(async ({ result, value, client, format }) => {
    const log = await client.log(result.runId).get();

    return callbackValue({
        value,
        args: log,
        format,
    });
});

/**
 * Executes lukaskrivka/results-checker with the provided taskId or with input
 */
const withChecker = generateCompare(async ({ result, value, args, runFn, client, format }) => {
    const taskArgs = safeOptions(args);
    const options = safeOptions(args);
    const isTask = !!taskArgs.taskId;

    if (!isTask && !taskArgs.functionalChecker) {
        return {
            pass: false,
            message: format('You must provide "functionalChecker" input to withChecker as a second parameter'),
        };
    }

    await settlementSleep();

    const runResult = await runFn({
        ...(isTask ? { taskId: taskArgs.taskId } : { actorId: 'lukaskrivka/results-checker' }),
        input: {
            apifyStorageId: taskArgs.recordKey ? result.data.defaultKeyValueStoreId : result.data.defaultDatasetId,
            ...taskArgs,
            functionalChecker: stringifyFn(taskArgs.functionalChecker),
        },
        options,
    });

    const { status } = await client.run(runResult.runId).get();

    if (status !== 'SUCCEEDED') {
        return {
            pass: false,
            message: format(`Checker run ${runResult.runId} failed. Check the log for more information`),
        };
    }

    const record = await client.keyValueStore(runResult.data.defaultKeyValueStoreId).getRecord('OUTPUT');

    return callbackValue({
        value,
        args: { runResult, output: record.value || {} },
        format,
    });
});

/**
 * Run the duplications-checker actor and get it's result
 */
const withDuplicates = generateCompare(async ({ result, value, args, runFn, client, format }) => {
    const input = safeOptions(args);
    const options = safeOptions(args);

    if (!input.fields || !Array.isArray(input.fields)) {
        return {
            pass: false,
            message: format('You need to provide a "fields" parameter as an array of strings on withDuplicates'),
        };
    }

    await settlementSleep();

    const runResult = await runFn({
        ...(input.taskId ? { taskId: input.taskId } : { actorId: 'lukaskrivka/duplications-checker' }),
        input: {
            datasetId: result.data.defaultDatasetId,
            showItems: false,
            ...input,
            preCheckFunction: stringifyFn(input.preCheckFunction),
        },
        options,
    });

    const { status } = await client.run(runResult.runId).get();

    if (status !== 'SUCCEEDED') {
        return {
            pass: false,
            message: format(`Duplicates run ${runResult.runId} failed. Check the actor log for more information.`),
        };
    }

    const record = await client.keyValueStore(runResult.data.defaultKeyValueStoreId).getRecord('OUTPUT');

    return callbackValue({
        value,
        args: { runResult, output: record.value || {} },
        format,
    });
});

/**
 * Access the KV OUTPUT directly
 */
const withOutput = generateCompare(async ({ result, value, client, format }) => {
    const record = await client.keyValueStore(result.data.defaultKeyValueStoreId).getRecord('OUTPUT');

    if (!record) {
        return {
            pass: false,
            message: format('No OUTPUT'),
        };
    }

    return callbackValue({
        value,
        args: record,
        format,
    });
});

/**
 * Access the KV Statistics, at index 0
 */
const withStatistics = generateCompare(async ({ result, value, client, format, args }) => {
    const options = safeOptions(args);
    const index = options.index || 0;

    await settlementSleep();

    const record = await client.keyValueStore(result.data.defaultKeyValueStoreId).getRecord(`SDK_CRAWLER_STATISTICS_${index}`);

    if (!record) {
        return {
            pass: false,
            message: format(`No SDK_CRAWLER_STATISTICS_${index}`),
        };
    }

    return callbackValue({
        value,
        args: record.value || {},
        format,
    });
});

/**
 * Access any key from the KV store
 */
const withKeyValueStore = generateCompare(async ({ result, value, client, format, args }) => {
    const options = safeOptions(args);

    if (!options.keyName || typeof options.keyName !== 'string') {
        return {
            pass: false,
            message: format('You need to specify the "keyName" parameter as { keyName: "KEY_NAME" }'),
        };
    }

    await settlementSleep();

    const record = await client.keyValueStore(result.data.defaultKeyValueStoreId).getRecord(options.keyName);

    if (!record) {
        return {
            pass: false,
            message: format(`Key "${options.keyName}" doesn't exists`),
        };
    }

    return callbackValue({
        value,
        args: record,
        format,
    });
});

/**
 * Access the result default requestQueue
 */
const withRequestQueue = generateCompare(async ({ result, value, client, format }) => {
    const requestQueue = await client.requestQueue(result.data.defaultRequestQueueId).get();

    return callbackValue({
        value,
        args: requestQueue,
        format,
    });
});

/**
 * Access the result default dataset
 */
const withDataset = generateCompare(async ({ result, value, args, client, format }) => {
    const options = safeOptions(args);

    // sometimes dataset information is wrong because there wasn't enough time
    // for it to settle for reading, so we need to wait at least 12 seconds to
    // ensure we won't fail the test because of a racing condition
    await settlementSleep();

    const [info, dataset] = await Promise.all([
        client.dataset(result.data.defaultDatasetId).get(),
        client.dataset(result.data.defaultDatasetId).listItems({ ...options }),
    ]);

    return callbackValue({
        value,
        args: { dataset, info },
        format,
    });
});

/**
 * @param {Jasmine} jasmine
 * @param {ApifyClient} client
 * @param {common.Runner} runFn
 */
const setupJasmine = (jasmine, client, runFn) => {
    jasmine.env.addAsyncMatchers({
        toHaveStatus: toHaveStatus(client, runFn),
        withLog: withLog(client, runFn),
        withDuplicates: withDuplicates(client, runFn),
        withChecker: withChecker(client, runFn),
        withDataset: withDataset(client, runFn),
        withOutput: withOutput(client, runFn),
        withKeyValueStore: withKeyValueStore(client, runFn),
        withRequestQueue: withRequestQueue(client, runFn),
        withStatistics: withStatistics(client, runFn),
    });
};

module.exports = {
    setupJasmine,
};
