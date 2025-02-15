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
 * @param {string | undefined} buildId
 * @return {Promise<{ defaultObj: Record<string, any>, prefill: Record<string, any> }>}
 */
const getActorInputInfo = async (client, actorId, buildId) => {
    // Either we get buildId from GitHub CI for PRs or we assume we need to fetch default version build
    // We hav to do either of those because without token, you cannot use build numbers
    if (!buildId) {
        const actorInfo = await client.actor(actorId).get();
        // All Actors should have default build but if someone forgot completely, we just don't prefill
        const defaultBuildTag = actorInfo?.defaultRunOptions.build;

        console.log(`Using default build ${defaultBuildTag} for actor ${actorId}`);
        console.log(`Actor info: ${JSON.stringify(actorInfo, null, 2)}`);

        const buildObj = actorInfo.taggedBuilds[defaultBuildTag || ''];
        if (!buildObj) {
            return {
                defaultObj: {},
                prefill: {},
            };
        }
        buildId = buildObj.buildId;
    }

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
 * @param {{ Apify: ApifyNM, client: ApifyClient, verboseLogs: boolean, retryFailedTests: boolean, customData: Record<string, any>}}
 * @return {Promise<common.Runner>}
 */
const setupRun = async ({ Apify, client, verboseLogs = false, retryFailedTests = false, customData = {} }) => {
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

        // To match a build to Actor ID, we can get it if the test calls a task
        let actorIdOfTask;
        if (isTask) {
            const task = await client.task(taskId).get();
            if (!task) {
                throw new Error(`Task ${taskId} used in the test spec was not found`);
            }
            actorIdOfTask = task.actId;
            console.log(`The task ID ${taskId} to run has actor ID ${actorIdOfTask} that is used to determine the build`);
        }
        // We resolve the build from string or object <actorOrTaskId>:<build> passed in input but user options have preference
        const buildFromInput = typeof customData.build === 'string' ? customData.build : customData.build?.[actorId || actorIdOfTask];
        const build = buildFromInput || options.build || undefined;

        const niceBuildName = build === undefined ? 'default build' : `build ${build}`;
        console.log(`Using ${niceBuildName} for ${actorId || taskId}`);

        // buildIds are passed in by GitHub CI for PR tests
        const buildId = customData?.buildIds?.[actorId || actorIdOfTask] || undefined;

        const { defaultObj = {}, prefill = {} } = prefilledInput ? await getActorInputInfo(client, actorId, buildId) : {};

        // TODO: This just lists some common max results fields we use but there is plenty more
        // Devs should use 'runInput' to calculate that themselves if they are not sure
        const maxResults = input.maxResults
            || input.resultsLimit
            || prefill.maxResults
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
                build,
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

        // add context to the currently running test spec, so that we can print the URL even if the spec fails on a vanilla Jasmine expect() call
        // we might want to add multiple run links, but there's no such thing as getSpecProperty or appending to array, so we just add multiple entries with random keys
        try {
            global.setSpecProperty(`relatedRunLink-${id}`, url);
        } catch (e) {
            // pass
            // run() might be run outside of a spec (`it()` block), and I'm not sure how to better detect this than with a try-catch
            // see also https://apify.slack.com/archives/C06MY7SS97C/p1727098499285779
        }

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

            // afaik we don't use this anywhere in this Actor itself, but the example input code does:
            format: common.formatRunMessage(runResult),

            maxResults,
            runInput,
        };
    };
};

export default setupRun;
