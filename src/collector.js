// adapted from https://github.com/DrewML/jasmine-json-test-reporter
module.exports = class {
    /**
     * @param {(results: any) => Promise<void>} onComplete
     */
    constructor(onComplete) {
        this.specResults = [];
        this.masterResults = {};
        this.onComplete = onComplete;
    }

    suiteDone(suite) {
        suite.specs = this.specResults;
        this.masterResults[suite.id] = suite;
        this.specResults = [];
    }

    specDone(spec) {
        this.specResults.push(spec);
    }

    jasmineDone(suiteInfo, done) {
        this.onComplete(this.masterResults).then(done);
    }
};
