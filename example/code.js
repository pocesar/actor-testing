/* eslint-disable no-unused-expressions */
/**
 * this code goes into testSpec parameter (Test spec)
 */
({ it, run, expect, expectAsync, jasmine, describe }) => {
    describe('Facebook', () => {
        it('works with biz listings', async () => {
            const runResult = await run({
                actorId: 'pocesar/facebook-pages-scraper',
                input: {
                    startUrls: [
                        {
                            url: 'https://www.facebook.com/biz/hotel-supply-service/?place_id=103095856397524',
                            method: 'GET',
                        },
                    ],
                    scrapeAbout: true,
                    scrapeReviews: true,
                    scrapePosts: true,
                    scrapeServices: true,
                    proxyConfiguration: {
                        useApifyProxy: true,
                    },
                    maxPosts: 20,
                },
            });

            await expectAsync(runResult).toHaveStatus('SUCCEEDED');

            await expectAsync(runResult).withDataset(({ info }) => {
                expect(info.cleanItemCount).toBeGreaterThan(15);
            });

            await expectAsync(runResult).withChecker(({ output }) => {
                expect(output.badItemCount).toBe(0);
            }, {
                taskId: 'pocesar/facebook-biz-checker',
            });
        });

        it('works with single pages', async () => {
            const runResult = await run({
                actorId: 'pocesar/facebook-pages-scraper',
                input: {
                    startUrls: [
                        {
                            url: 'https://www.facebook.com/apifytech',
                            method: 'GET',
                        },
                    ],
                    scrapeAbout: true,
                    scrapeReviews: true,
                    scrapePosts: true,
                    scrapeServices: true,
                    proxyConfiguration: {
                        useApifyProxy: true,
                    },
                    maxPosts: 20,
                },
            });

            await expectAsync(runResult).toHaveStatus('SUCCEEDED');
        });
    });
};
