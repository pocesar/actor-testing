const Apify = require('apify');
const Jasmine = require('jasmine');
const { SpecReporter } = require('jasmine-spec-reporter');
const Loader = require('jasmine/lib/loader');
const { setupJasmine } = require('./matchers');
const setupRun = require('./run');
const JSONReporter = require('./collector');

Apify.main(async () => {
    const input = await Apify.getInput();
    const { defaultTimeout = 300000, filter } = input;

    // hacking jasmine internals to accept non-existing files
    const instance = new Jasmine({
        loader: new Loader({
            requireShim: (filename) => {
                if (filename === 'jasmine-expect') {
                    return require('jasmine-expect'); // eslint-disable-line
                }
                return Promise.resolve();
            },
        }),
    });

    instance.env.clearReporters();

    instance.addReporter(new SpecReporter({ // add jasmine-spec-reporter
        spec: {
            displaySuccessful: true,
            displayFailed: true,
            displayPending: true,
            displayDuration: true,
            displayStacktrace: 'none',
        },
        summary: {
            displayDuration: true,
            displayErrorMessages: false,
            displaySuccessful: false,
            displayPending: false,
            displayStacktrace: 'none',
            displayFailed: false,
        },
    }));

    instance.addReporter(new JSONReporter(async (testResult) => {
        await Apify.setValue('OUTPUT', testResult);
    }));

    const token = input.token || Apify.getEnv().token;

    jasmine.DEFAULT_TIMEOUT_INTERVAL = defaultTimeout;
    const runFn = await setupRun(Apify, token);

    // jasmine executes everything as global, so we just eval it here
    ((context) => {
        const { describe, beforeAll } = context;

        describe('Actor tests', () => {
            beforeAll(() => {
                setupJasmine(
                    instance,
                    token,
                    runFn,
                );
            });

            eval(input.testSpec)({ // eslint-disable-line no-eval
                ...context,
                input,
            });
        });
    })({
        ...instance.env,
        run: runFn,
    });

    instance.addSpecFile('test.js');
    instance.helperFiles.push('jasmine-expect');
    instance.randomizeTests(false);
    instance.stopSpecOnExpectationFailure(false);

    await instance.execute(undefined, filter);
});
