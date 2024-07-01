import Apify from 'apify';

const { log } = Apify.utils;

// adapted from https://github.com/DrewML/jasmine-json-test-reporter
export default class {
    /**
     * @param {(results: any, info: any) => Promise<void>} onComplete
     * @param {boolean} [verboseLogs]
     */
    constructor(onComplete, verboseLogs) {
        this.specResults = [];
        this.masterResults = {};
        this.onComplete = onComplete;
        this.verboseLogs = verboseLogs;
    }

    specStarted(spec) {
        if (this.verboseLogs) {
            const { fullName, id } = spec;
            log.info(`Running: ${spec.description}`, { fullName, id });
        }
    }

    suiteDone(suite) {
        suite.specs = this.specResults;
        this.masterResults[suite.id] = suite;
        this.specResults = [];
    }

    specDone(spec) {
        this.specResults.push(spec);
        if (this.verboseLogs) {
            const { fullName, id } = spec;
            log.info(`Done: ${spec.description}`, { fullName, id });
        }
    }

    jasmineDone(suiteInfo, done) {
        this.onComplete(this.masterResults, suiteInfo).then(done, (e) => {
            log.exception(e, 'Jasmine done');
            done();
        });
    }
};
