const ApifyNM = require('apify'); // eslint-disable-line
const { ApifyClient } = require('apify-client'); // eslint-disable-line
const { XXHash64 } = require('xxhash-addon');
const common = require('./common');

const quickHash = () => {
    const hasher = new XXHash64();
    return (/** @type {string} */value) => hasher.hash(Buffer.from(value)).toString('hex');
};

/**
 * @param {ApifyClient} client
 * @param {string} runId
 * @param {(num: number) => Promise<void>} sleep
 */
const waitForFinish = async (client, runId, sleep) => {
    const run = client.run(runId);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            const { status } = await run.get();
            if (status !== 'RUNNING' && status !== 'READY') {
                break;
            }
            await sleep(1000);
        } catch (e) {
            break;
        }
    }
};

/**
 * @param {string} actorId
 * @param {string} build
 * @return {Promise<Record<string, any>>}
 */
const getActorInputPrefill = async (actorId, build = 'latest') => {
    const actorInfoResponse = await fetch(`https://api.apify.com/v2/acts/${actorId}`);
    const actorInfo = JSON.parse(await actorInfoResponse.text());

    const { buildId } = actorInfo.data.taggedBuilds[build];

    const buildInfoResponse = await fetch(`https://api.apify.com/v2/actor-builds/${buildId}`);
    const buildInfo = JSON.parse(await buildInfoResponse.text());

    const inputSchema = JSON.parse(buildInfo.data.inputSchema);

    const prefill = {};

    for (const [propertyName, propertyValue] of Object.entries(inputSchema.properties)) {
        if (propertyValue.prefill !== undefined) {
            prefill[propertyName] = propertyValue.prefill;
        }
    }

    return prefill;
}

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

        const prefill = prefilledInput ? getActorInputPrefill(actorId, options.build) : {};

        if (!runMap.has(id)) {
            // looks duplicated code, but we need to run it once,
            // as it shouldn't run when there's a migration
            const runResult = await client[isTask ? 'task' : 'actor'](taskId || actorId).call({
                ...prefill,
                ...input,
            }, {
                ...options,
                waitSecs: 0,
            });

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
                ...data
            } = runResult;

            const { name: actorName } = await client.actor(data.actId).get();
            const { name: taskName } = isTask && taskId ? await client.task(taskId).get() : {};

            runMap.set(id, {
                hashCode: id,
                data: {
                    ...data,
                    taskId,
                    actorName,
                    taskName,
                    name: run.name,
                },
                runId: runResult.id,
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
        await waitForFinish(client, runId, Apify.utils.sleep);

        if (verboseLogs) {
            Apify.utils.log.info(
                `Run ${isTask ? `task ${taskId}` : `actor ${actorId}`} finished: ${url}`,
                { ...run },
            );
        }

        await persistState();

        // Sleep 5 sec so dataset itemCount is properly updated
        await new Promise((res) => setTimeout(res, 5000));

        return {
            ...runResult,
            format: common.formatRunMessage(runResult),
        };
    };
};

module.exports = setupRun;
