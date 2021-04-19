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
    let passed = 0;
    let totalSpecs = 0;
    let passingSpecs = 0;
    let total = 0;
    let failedSpecs = 0;

    /**
     * @type {Array<{ name: string, markdown: string, html: string }>}
     */
    const failed = Object.values(result).flatMap((v) => {
        totalSpecs += v?.specs?.length ?? 0;
        total += v?.specs?.reduce((out, spec) => (out + spec.failedExpectations.length + spec.passedExpectations.length), 0) ?? 0;

        if (!v?.specs?.length || !v.specs.some((spec) => spec.failedExpectations.length)) {
            passingSpecs++;
            return [];
        }

        return v.specs.flatMap((spec) => {
            passed += spec.passedExpectations.length;
            failedSpecs += spec.failedExpectations.length ? 1 : 0;

            return spec.failedExpectations.map((s) => {
                return {
                    name: `${v.description} ${spec.description}`,
                    markdown: `\`\`\`${linkToFormat(s.message, (link) => `<${link}|${link.split('/').pop()}>`)}\`\`\``,
                    html: linkToFormat(s.message, (link) => `<a href=${link}>${link.split('/').pop()}</a>`),
                };
            });
        });
    });

    return {
        failed,
        passed,
        totalSpecs,
        passingSpecs,
        failedSpecs,
        total,
    };
};

const nameBreak = () => {
    let last = '';
    return (name, separator) => {
        if (name !== last) {
            last = name;
            return `${name}${separator}`;
        }

        return '';
    };
};

module.exports = {
    formatRunMessage,
    isRunResult,
    nameBreak,
    collectFailed,
};
