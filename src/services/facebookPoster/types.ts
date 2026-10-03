import type { BrowserContext, Page } from 'playwright-core';

export type LogLevel = 'info' | 'success' | 'warning' | 'error';

export interface LaunchedPage { ctx: BrowserContext; page: Page; }

export interface TaskDeps {
    /** Opens the profile's automation browser. The task closes ctx itself when done (as FB Poster did). */
    launch: () => Promise<LaunchedPage>;
    getIsStopping: () => boolean;
    sendLog: (message: string, level: LogLevel) => void;
    updateProgress: (percent: number, label: string) => void;
}
