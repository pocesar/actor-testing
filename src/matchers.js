const Apify = require('apify');
const Jasmine = require('jasmine'); // eslint-disable-line no-unused-vars
const runTypes = require('./run'); // eslint-disable-line no-unused-vars

/** @param {runTypes.Result} run */
const isRunResult = (run) => run
    && typeof run.hashCode === 'string'
    && !!run.hashCode
    && !!run.data;

/**
 * Make the comparision composable without boilerplate
 *
 * @param {(param: {
 *  result: runTypes.Result,
 *  value: any,
 *  utils: { equals: (a: value, b: value) => boolean },
 *  token: string,
 *  args: any[],
 *  runFn: runTypes.Runner
 * }) => Promise<{ pass: boolean, message: string }>} compare
 */
const generateCompare = (compare) => (/** @type {string} */token, /** @type {runTypes.Runner} */runFn) => (utils) => ({
    /**
     * @param {runTypes.Result} result
     */
    async compare(result, value, ...args) {
        if (!isRunResult(result)) {
            throw new Error('Invalid usage of expectAsync on non-run result. Did you forget to run()?');
        }

        return compare({ result, value, args, utils, token, runFn });
    },
});

/**
 * toString() a function if given as a parameter, or return itself
 */
const stringifyFn = (fn) => (typeof fn === 'function' ? fn.toString() : fn);

/**
 * @param {(args: any) => Promise<void>} value
 * @param {any} args
 * @param {string} [message]
 */
const callbackValue = async (value, args, message = '') => {
    try {
        await value(args);

        return {
            pass: true,
        };
    } catch (e) {
        return {
            pass: false,
            message: message || e.message,
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

const toHaveStatus = generateCompare(async ({ result, value, utils, token }) => {
    const run = await Apify.client.acts.getRun({
        actId: result.data.actId,
        runId: result.data.id,
        token,
    });

    return {
        pass: utils.equals(run.status, value),
        message: `Expected run ${result.runId} status to be "${value}", got "${run.status}"`,
    };
});

/**
 * Retrieve the run log
 */
const withLog = generateCompare(async ({ result, value }) => {
    const log = await Apify.client.logs.getLog({
        logId: result.runId,
    });

    return callbackValue(value, log);
});

/**
 * Executes lukaskrivka/results-checker with the provided taskId or with input
 */
const withChecker = generateCompare(async ({ result, value, args, runFn, token }) => {
    const taskArgs = safeOptions(args);
    const options = safeOptions(args);
    const isTask = !!taskArgs.taskId;

    if (!isTask && !taskArgs.functionalChecker) {
        return {
            pass: false,
            message: 'You must provide "functionalChecker" input to withChecker as a second parameter',
        };
    }

    const runResult = await runFn({
        ...(isTask ? { taskId: taskArgs.taskId } : { actorId: 'lukaskrivka/results-checker' }),
        input: {
            apifyStorageId: taskArgs.recordKey ? result.data.defaultKeyValueStoreId : result.data.defaultDatasetId,
            ...taskArgs,
            functionalChecker: stringifyFn(taskArgs.functionalChecker),
        },
        options: {
            ...options,
            token,
        },
    });

    const { status } = await Apify.client.acts.getRun({
        runId: runResult.runId,
        actId: runResult.data.actId,
        token,
    });

    if (status !== 'SUCCEEDED') {
        return {
            pass: false,
            message: `Checker run ${runResult.runId} failed. Check the log for more information`,
        };
    }

    const record = await Apify.client.keyValueStores.getRecord({
        storeId: runResult.data.defaultKeyValueStoreId,
        key: 'OUTPUT',
        token,
    });

    return callbackValue(value, { runResult, output: record.body || {} });
});

/**
 * Run the duplications-checker actor and get it's result
 */
const withDuplicates = generateCompare(async ({ result, value, args, runFn, token }) => {
    const input = safeOptions(args);
    const options = safeOptions(args);

    if (!input.fields || !Array.isArray(input.fields)) {
        return {
            pass: false,
            message: 'You need to provide a "fields" parameter as an array of strings on withDuplicates',
        };
    }

    const runResult = await runFn({
        ...(input.taskId ? { taskId: input.taskId } : { actorId: 'lukaskrivka/duplications-checker' }),
        input: {
            datasetId: result.data.defaultDatasetId,
            showItems: false,
            ...input,
            preCheckFunction: stringifyFn(input.preCheckFunction),
        },
        options: {
            ...options,
            token,
        },
    });

    const { status } = await Apify.client.acts.getRun({
        runId: runResult.runId,
        actId: runResult.data.actId,
        token,
    });

    if (status !== 'SUCCEEDED') {
        return {
            pass: false,
            message: `Duplicates run ${runResult.runId} failed. Check the log for more information`,
        };
    }

    const record = await Apify.client.keyValueStores.getRecord({
        storeId: runResult.data.defaultKeyValueStoreId,
        key: 'OUTPUT',
        token,
    });

    return callbackValue(value, { runResult, output: record.body || {} });
});

/**
 * Access the KV OUTPUT directly
 */
const withOutput = generateCompare(async ({ result, value, token }) => {
    const record = await Apify.client.keyValueStores.getRecord({
        storeId: result.data.defaultKeyValueStoreId,
        key: 'OUTPUT',
        token,
    });

    if (!record) {
        return {
            pass: false,
            message: `Run "${result.runId}" has no OUTPUT`,
        };
    }

    return callbackValue(value, record);
});

/**
 * Access the KV Statistics, at index 0
 */
const withStatistics = generateCompare(async ({ result, value, token, args }) => {
    const options = safeOptions(args);
    const index = options.index || 0;

    const record = await Apify.client.keyValueStores.getRecord({
        storeId: result.data.defaultKeyValueStoreId,
        key: `SDK_CRAWLER_STATISTICS_${index}`,
        token,
    });

    if (!record) {
        return {
            pass: false,
            message: `Run "${result.runId}" has no SDK_CRAWLER_STATISTICS_${index}`,
        };
    }

    return callbackValue(value, record.body || {});
});

/**
 * Access any key from the KV store
 */
const withKeyValueStore = generateCompare(async ({ result, value, token, args }) => {
    const options = safeOptions(args);

    if (!options.keyName || typeof options.keyName !== 'string') {
        return {
            pass: false,
            message: 'You need to specify the "keyName" parameter as { keyName: "KEY_NAME" }',
        };
    }

    const record = await Apify.client.keyValueStores.getRecord({
        storeId: result.data.defaultKeyValueStoreId,
        key: options.keyName,
        disableRedirect: true,
        token,
    });

    if (!record) {
        return {
            pass: false,
            message: `Key "${options.keyName}" doesn't exists on run "${result.runId}"`,
        };
    }

    return callbackValue(value, record);
});

/**
 * Access the result default requestQueue
 */
const withRequestQueue = generateCompare(async ({ result, value, token }) => {
    const requestQueue = await Apify.client.requestQueues.getQueue({
        queueId: result.data.defaultRequestQueueId,
        token,
    });

    return callbackValue(value, requestQueue);
});

/**
 * Access the result default dataset
 */
const withDataset = generateCompare(async ({ result, value, args, token }) => {
    const options = safeOptions(args);

    // sometimes dataset information is wrong because there wasn't enough time
    // for it to settle for reading, so we need to wait at least 12 seconds to
    // ensure we won't fail the test because of a racing condition
    await Apify.utils.sleep(12000);

    const [info, dataset] = await Promise.all([
        Apify.client.datasets.getDataset({
            datasetId: result.data.defaultDatasetId,
            token,
        }),
        Apify.client.datasets.getItems({
            ...options,
            datasetId: result.data.defaultDatasetId,
            token,
        }),
    ]);

    return callbackValue(value, { dataset, info });
});

/**
 * @param {Jasmine} jasmine
 * @param {string} token
 * @param {runTypes.Runner} runFn
 */
const setupJasmine = (jasmine, token, runFn) => {
    jasmine.env.addAsyncMatchers({
        toHaveStatus: toHaveStatus(token, runFn),
        withLog: withLog(token, runFn),
        withDuplicates: withDuplicates(token, runFn),
        withChecker: withChecker(token, runFn),
        withDataset: withDataset(token, runFn),
        withOutput: withOutput(token, runFn),
        withKeyValueStore: withKeyValueStore(token, runFn),
        withRequestQueue: withRequestQueue(token, runFn),
        withStatistics: withStatistics(token, runFn),
    });
};

module.exports = {
    setupJasmine,
};
