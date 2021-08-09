const Apify = require('apify');

const { log } = Apify.utils;

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
 *   > & { actorName: string, taskName?: string, name?: string, taskId?: string },
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
    }:${runResult.data.buildNumber}\n${createRunLink({ actorId: runResult.data.actId, taskId: runResult.data.taskId, runId: runResult.runId })} : ${message}`;
    return formatted;
};

/**
 * @param {{
 *   runId: string,
 *   actorId: string,
 *   taskId?: string,
 * }} params
 */
const createRunLink = ({ actorId, taskId, runId }) => {
    return `https://my.apify.com/${taskId ? 'tasks' : 'actors'}/${taskId || actorId}#/runs/${runId}`;
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

/**
 * Only displays new banner if the value changes
 *
 * @returns {(name: string, separator: string) => string}
 */
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

/**
 * Notify Slack / Email
 *
 * @param {{ slackToken?: string, slackChannel?: string, email?: string }} input
 * @returns {(params: { emailMessage?: string, slackMessage?: string, subject?: string }) => Promise<void>}
 */
const createNotifier = (input) => {
    return async ({ emailMessage, slackMessage, subject }) => {
        if (input.slackToken && input.slackChannel && slackMessage) {
            log.info(`Posting to channel ${input.slackChannel}`);

            try {
                await Apify.call('katerinahronik/slack-message', {
                    token: input.slackToken,
                    channel: input.slackChannel,
                    text: slackMessage,
                }, {
                    fetchOutput: false,
                    waitSecs: 1,
                });
            } catch (e) {
                log.exception(e, 'Slack message');
            }
        }

        if (input.email?.trim().includes('@') && emailMessage && subject) {
            log.info(`Sending email to ${input.email}`);

            try {
                await Apify.call('apify/send-mail', {
                    to: input.email.trim(),
                    subject,
                    text: '',
                    html: emailMessage,
                }, {
                    fetchOutput: false,
                    waitSecs: 1,
                });
            } catch (e) {
                log.exception(e, 'Send email');
            }
        }
    };
};

module.exports = {
    formatRunMessage,
    isRunResult,
    nameBreak,
    collectFailed,
    createNotifier,
    createRunLink,
};
