import { chromium, type BrowserContext } from 'playwright-core';

/**
 * Lets Playwright launch the antidetect engine itself so it can drive it over --remote-debugging-pipe.
 * ignoreDefaultArgs: true drops Playwright's 38 default switches (measured 03/10/2026), so the browser
 * gets exactly the flags of a manual open plus the pipe. See docs/reports/2026-10-03-browser-automation-pipe-spike.md.
 */
export function launchAutomationBrowser(executablePath: string, userDataDir: string, args: string[]): Promise<BrowserContext> {
    return chromium.launchPersistentContext(userDataDir, {
        executablePath,
        headless: false,
        viewport: null,
        ignoreDefaultArgs: true,
        args,
        timeout: 60000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
    });
}
