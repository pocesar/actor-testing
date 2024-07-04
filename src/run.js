import ApifyNM from 'apify'; // eslint-disable-line
import { ApifyClient } from 'apify-client'; // eslint-disable-line
import { XXHash64 } from 'xxhash-addon';
import * as common from './common.js';

const quickHash = () => {
    const hasher = new XXHash64();
    return (/** @type {string} */value) => hasher.hash(Buffer.from(value)).toString('hex');
};

/**
 * @param {ApifyClient} client
 * @param {string} actorId
 * @param {string} build
 * @return {Promise<{ defaultObj: Record<string, any>, prefill: Record<string, any> }>}
 */
const getActorInputInfo = async (client, actorId, build = 'latest') => {
    const actorInfo = await client.actor(actorId).get();

    // FIXME: This will not work with build numbers, we need to use different API for that (not sure if possible without token?)
    if (build.match(/^\d+\.\d+\.\d+$/)) {
        console.warn(`WARNING! Build number is not currently supported for prefilledInput: true, using 'latest' instead`);
        build = 'latest';
    }
    const { buildId } = actorInfo.taggedBuilds[build];

    const buildInfo = await client.build(buildId).get();

    const inputSchema = JSON.parse(buildInfo.inputSchema);

    const defaultObj = {};
    const prefill = {};

    for (const [propertyName, propertyValue] of Object.entries(inputSchema.properties)) {
        if (propertyValue.prefill !== undefined) {
            prefill[propertyName] = propertyValue.prefill;
        }

        if (propertyValue.default !== undefined) {
            defaultObj[propertyName] = propertyValue.default;
        }
    }

    return {
        defaultObj,
        prefill,
    };
};

/**
 * @param {ApifyNM} Apify
 * @param {ApifyClient} client
 * @param {boolean} verboseLogs
 * @param {boolean} retryFailedTests Need this as a nonce to calls
 * @return {Promise<common.Runner>}
 */
const setupRun = async (Apify, client, verboseLogs = false, retryFailedTests = false) => {
    const hasher = quickHash();

    const kv = await Apify.openKeyValueStore();
    /** @type {Map<string, common.Result>} */
    const runMap = new Map(await kv.getValue('CALLS'));

    const persistState = async () => {
        await kv.setValue('CALLS', [...runMap.entries()]);
    };

    Apify.events.on('persistState', persistState);

    return async (run) => {
        const { taskId, actorId, input = {}, options = {}, prefilledInput = false } = run;

        if (!taskId && !actorId) {
            throw new Error('You need to provide either taskId or actorId');
        }

        if (taskId && actorId) {
            throw new Error('You need to provide just taskId or actorId, but not both');
        }

        if (taskId && prefilledInput) {
            throw new Error('prefilledInput currently works only with actorId, not taskId');
        }

        const isTask = !!taskId;
        const id = hasher(JSON.stringify({ ...run, retryFailedTests }));

        const { defaultObj = {}, prefill = {} } = prefilledInput ? await getActorInputInfo(client, actorId, options.build) : {};

        // TODO: This just lists some common max results fields we use but there is plenty more
        // Devs should use 'runInput' to calculate that themselves if they are not sure
        const maxResults = prefill.maxResults
            || prefill.resultsLimit
            || defaultObj.maxResults
            || defaultObj.resultsLimit;

        if (!runMap.has(id)) {
            // looks duplicated code, but we need to run it once,
            // as it shouldn't run when there's a migration
            const runInfo = await client[isTask ? 'task' : 'actor'](taskId || actorId).call({
                ...prefill,
                ...input,
            }, {
                ...options,
                waitSecs: 0,
            });

            const { name: actorName } = await client.actor(runInfo.actId).get();
            const { name: taskName } = isTask && taskId ? await client.task(taskId).get() : {};

            runMap.set(id, {
                hashCode: id,
                data: {
                    ...runInfo,
                    taskId,
                    actorName,
                    taskName,
                    name: run.name,
                },
                runId: runInfo.id,
            });
        }

        /** @type {common.Result} */
        const runResult = runMap.get(id);
        const { runId } = runResult;
        const url = common.createRunLink({ actorId, taskId, runId });

        if (verboseLogs) {
            Apify.utils.log.info(
                `Waiting ${isTask ? `task ${taskId}` : `actor ${actorId}`} to finish: ${url}`,
                { ...run },
            );
        }

        await persistState();
        await client.run(runId).waitForFinish();

        // We fetch the actual input which will include defaults added by platform so devs can use it
        const runInput = (await client.keyValueStore(runResult.data.defaultKeyValueStoreId).getRecord('INPUT'))?.value || {};

        if (verboseLogs) {
            Apify.utils.log.info(
                `Run ${isTask ? `task ${taskId}` : `actor ${actorId}`} finished: ${url}`,
                { ...run },
            );
        }

        await persistState();

        // NOTE: We used to sleep here to get dataset.itemCount update but it is not necessary
        // Devs should instead use dataset.items which we already fetch anyway and those are always up to date

        return {
            ...runResult,
            format: common.formatRunMessage(runResult),
            maxResults,
            runInput,
        };
    };
};

export default setupRun;
