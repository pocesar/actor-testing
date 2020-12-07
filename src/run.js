const ApifyNM = require('apify'); // eslint-disable-line
const { XXHash64 } = require('xxhash-addon');

const quickHash = () => {
    const hasher = new XXHash64();
    return (/** @type {string} */value) => hasher.hash(Buffer.from(value)).toString('hex');
};

/**
 * @typedef {{
 *   runId: string,
 *   hashCode: string,
 *   data: Pick<ApifyNM.ActorRun,
 *      | 'actId'
 *      | 'defaultDatasetId'
 *      | 'defaultKeyValueStoreId'
 *      | 'defaultRequestQueueId'
 *      | 'id'
 *      | 'buildNumber'
 *   >,
 * }} Result
 */

/**
 * @typedef {(params: RunParams) => Promise<Result>} Runner
 */

/**
 * @typedef {{
 *  taskId?: string,
 *  actorId?: string,
 *  input?: any,
 *  options?: Parameters<ApifyNM.callTask>[2]
 *  nonce?: string
 * }} RunParams
 */

/**
 * @param {ApifyNM} Apify
 * @param {string} token
 * @return {Promise<Runner>}
 */
const setupRun = async (Apify, token = Apify.getEnv().token) => {
    const hasher = quickHash();

    const kv = await Apify.openKeyValueStore();
    /** @type {Map<string, Result>} */
    const runMap = new Map(await kv.getValue('CALLS'));

    const persistState = async () => {
        await kv.setValue('CALLS', [...runMap.entries()]);
    };

    Apify.events.on('persistState', persistState);

    return async (run) => {
        const { taskId, actorId, input = {}, options = {} } = run;

        if (!taskId && !actorId) {
            throw new Error('You need to provide either taskId or actorId');
        }

        if (taskId && actorId) {
            throw new Error('You need to provide just taskId or actorId, but not both');
        }

        const id = hasher(JSON.stringify(run));

        if (!runMap.has(id)) {
            // looks duplicated code, but we need to run it once,
            // as it shouldn't run when there's a migration
            const runResult = await Apify[taskId ? 'callTask' : 'call'](
                taskId || actorId,
                input,
                {
                    ...options,
                    waitSecs: 0,
                },
            );

            const {
                buildId,
                containerUrl,
                exitCode,
                meta,
                options: opts,
                output,
                status,
                startedAt,
                finishedAt,
                userId,
                runtime,
                stats,
                ...data
            } = runResult;

            runMap.set(id, {
                hashCode: id,
                data: {
                    ...data,
                },
                runId: runResult.id,
            });
        }

        const runResult = runMap.get(id);
        const { runId, data: { actId } } = runResult;

        await Apify.utils.waitForRunToFinish({
            actorId: actId,
            runId,
            token,
        });

        await persistState();

        return runResult;
    };
};

module.exports = setupRun;
