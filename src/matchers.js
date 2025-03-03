import { ApifyClient } from 'apify-client'; // eslint-disable-line no-unused-vars
import Jasmine from 'jasmine'; // eslint-disable-line no-unused-vars
import * as common from './common.js'; // eslint-disable-line no-unused-vars

/**
 * @typedef {(
 *   param: {
 *     result: common.Result,
 *     value: any,
 *     utils: jasmine.MatchersUtil,
 *     client: ApifyClient,
 *     args: any[],
 *     runFn: common.Runner,
 *     format: (message: string) => string
 *   }
 * ) => Promise<{ pass: boolean, message?: string }>} CompareFunction
 */

/**
 * Make the comparision composable without boilerplate
 *
 * @param {CompareFunction} compare
 * @param {ApifyClient} client
 * @param {common.Runner} runFn
 */
function generateCompare(compare, client, runFn) {
    /**
     * @param {jasmine.MatchersUtil} utils
     *
     * This function is passed to Jasmine, which then later instantiates the Matcher with the utils object
     */
    return function(utils) {
        // The Matcher:
        return {
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
        };
    };
}

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

/** @type {CompareFunction} */
const toHaveStatus = async ({ result, value, utils, client, format }) => {
    const run = await client.run(result.runId).get();

    return {
        pass: utils.equals(run.status, value),
        message: format(`Expected status to be "${value}", got "${run.status}"`),
    };
};

/**
 * Retrieve the run log
 */
const withLog = async ({ result, value, client, format }) => {
    const log = await client.log(result.runId).get();

    return callbackValue({
        value,
        args: log,
        format,
    });
};

/**
 * Retrieve the run info
 */
const withRunInfo = async ({ result, value, client, format }) => {
    // stuff like `run.chargedEventCounts` may be updated couple seconds after the run is finished so we wait 10 seconds
    await new Promise(res => setTimeout(res, 10_000))
    const runInfo = await client.run(result.runId).get();

    return callbackValue({
        value,
        args: runInfo,
        format,
    })
}

/**
 * @type {CompareFunction}
 * Executes lukaskrivka/results-checker with the provided taskId or with input
 */
const withChecker = async ({ result, value, args, runFn, client, format }) => {
    const taskArgs = safeOptions(args);
    const options = safeOptions(args);
    const isTask = !!taskArgs.taskId;

    if (!isTask && !taskArgs.functionalChecker) {
        return {
            pass: false,
            message: format('You must provide "functionalChecker" input to withChecker as a second parameter'),
        };
    }

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
};

/**
 * @type {CompareFunction}
 * Run the duplications-checker actor and get it's result
 */
const withDuplicates = async ({ result, value, args, runFn, client, format }) => {
    const input = safeOptions(args);
    const options = safeOptions(args);

    if (!input.fields || !Array.isArray(input.fields)) {
        return {
            pass: false,
            message: format('You need to provide a "fields" parameter as an array of strings on withDuplicates'),
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
};

/**
 * @type {CompareFunction}
 * Access the KV OUTPUT directly
 */
const withOutput = async ({ result, value, client, format }) => {
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
};

/**
 * @type {CompareFunction}
 * Access the KV Statistics, at index 0
 */
const withStatistics = async ({ result, value, client, format, args }) => {
    const options = safeOptions(args);
    const index = options.index || 0;

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
};

/**
 * @type {CompareFunction}
 * Access any key from the KV store
 */
const withKeyValueStore = async ({ result, value, client, format, args }) => {
    const options = safeOptions(args);

    if (!options.keyName || typeof options.keyName !== 'string') {
        return {
            pass: false,
            message: format('You need to specify the "keyName" parameter as { keyName: "KEY_NAME" }'),
        };
    }

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
};

/**
 * @type {CompareFunction}
 * Access the result default requestQueue
 */
const withRequestQueue = async ({ result, value, client, format }) => {
    const requestQueue = await client.requestQueue(result.data.defaultRequestQueueId).get();

    return callbackValue({
        value,
        args: requestQueue,
        format,
    });
};

/**
 * @type {CompareFunction}
 * Access the result default dataset
 */
const withDataset = async ({ result, value, args, client, format }) => {
    const options = safeOptions(args);

    const [info, dataset] = await Promise.all([
        client.dataset(result.data.defaultDatasetId).get(),
        client.dataset(result.data.defaultDatasetId).listItems({ ...options, clean: true }),
    ]);

    // To prevent bugs related to platform needing sleep to update info.itemCount, we hardset it to the actual length of items
    if (!options.limit && !options.offset) {
        info.itemCount = dataset.items?.length || 0;
        info.cleanItemCount = dataset.items?.length || 0;
    }

    return callbackValue({
        value,
        args: { dataset, info },
        format,
    });
};

const matcherFunctions = {
    toHaveStatus,
    withLog,
    withDuplicates,
    withChecker,
    withDataset,
    withOutput,
    withKeyValueStore,
    withRequestQueue,
    withRunInfo,
    withStatistics,
};

/**
 * @param {Jasmine} jasmine
 * @param {ApifyClient} client
 * @param {common.Runner} runFn
 */
export const setupJasmine = (jasmine, client, runFn) => {
    /** @type {jasmine.CustomAsyncMatcherFactories} */
    const curriedMatchers = {};
    for (const [key, function_] of Object.entries(matcherFunctions)) {
        curriedMatchers[key] = generateCompare(function_, client, runFn);
    }

    jasmine.env.addAsyncMatchers(curriedMatchers);
};
