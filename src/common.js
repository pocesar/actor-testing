const Apify = require('apify'); // eslint-disable-line no-unused-vars
/**
 * @typedef {{
    *   runId: string,
    *   hashCode: string,
    *   data: Pick<Apify.ActorRun,
    *      | 'actId'
    *      | 'defaultDatasetId'
    *      | 'defaultKeyValueStoreId'
    *      | 'defaultRequestQueueId'
    *      | 'id'
    *      | 'buildNumber'
    *      | 'stats'
    *   > & { actorName: string, taskName?: string, name?: string },
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
 *  name?: string,
 *  options?: Parameters<Apify.callTask>[2]
 *  nonce?: string
 * }} RunParams
 */

/** @param {Result} run */
const isRunResult = (run) => run
    && typeof run.hashCode === 'string'
    && !!run.hashCode
    && !!run.data;

/**
 * @param {Result} runResult
 * @returns {(message: string) => string}
 */
const formatRunMessage = (runResult) => (message) => {
    const formatted = `${
        runResult.data.name ? `${runResult.data.name}\n` : ''
    }${
        runResult.data.taskName ? `${runResult.data.taskName} - ${runResult.data.actorName}` : runResult.data.actorName
    }:${runResult.data.buildNumber}\nhttps://my.apify.com/actors/${runResult.data.actId}#/runs/${runResult.runId} : ${message}`;
    return formatted;
};

/**
 * @param {string} body
 * @param {(match: string) => string} match
 */
const linkToFormat = (body, match) => {
    return [...body.matchAll(/(https:\/\/[\S]+)/gm)].reduce((out, matches) => {
        if (!matches[1]) {
            return out;
        }

        return `${out.slice(0, matches.index)}${out.slice(matches.index).replace(matches[1], match(matches[1]))}`;
    }, body);
};

/** @param {any} result */
const collectFailed = (result) => {
    return Object.values(result).flatMap((v) => {
        if (!v.specs || !v.specs.length || !v.specs.some((spec) => spec.failedExpectations.length)) {
            return [];
        }

        return v.specs.flatMap((spec) => spec.failedExpectations.map((s) => {
            return {
                markdown: `\`\`\`${linkToFormat(s.message, (link) => `<${link}|${link.split('/').pop()}>`)}\`\`\``,
                html: linkToFormat(s.message, (link) => `<a href=${link}>${link.split('/').pop()}</a>`),
            };
        }));
    });
};

module.exports = {
    formatRunMessage,
    isRunResult,
    collectFailed,
};
