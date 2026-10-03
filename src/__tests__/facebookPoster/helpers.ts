/** Runs `run` with jest fake timers, ticking 5 s at a time until it settles (max 500 ticks), like FB Poster's runWithFakeTimers. */
export async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
    jest.useFakeTimers();
    try {
        const promise = run();
        let settled = false;
        promise.then(() => { settled = true; }, () => { settled = true; });
        for (let i = 0; i < 500 && !settled; i++) {
            await jest.advanceTimersByTimeAsync(5000);
        }
        return await promise;
    } finally {
        jest.useRealTimers();
    }
}

/** Fake Playwright locator registry: records which data-maihub-target values were clicked. */
export function fakeLocators(clicked: string[]) {
    return (selector: string) => ({
        first: () => ({
            click: async () => {
                const m = /data-maihub-target="([^"]+)"/.exec(selector);
                clicked.push(m ? m[1] : selector);
            },
        }),
    });
}
