import type { Page } from 'playwright-core';

/** Ngủ ngẫu nhiên trong khoảng [min, max] mili-giây. */
export const delayRandom = (minMs: number, maxMs: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs));

/** Click vào một điểm ngẫu nhiên trong 60% giữa của phần tử, có di chuyển chuột. */
export const humanClick = async (page: Page, selector: string): Promise<void> => {
    const element = await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
    const box = await element.boundingBox();
    if (!box) {
        await element.click();
        return;
    }
    const x = box.x + box.width * 0.2 + Math.random() * box.width * 0.6;
    const y = box.y + box.height * 0.2 + Math.random() * box.height * 0.6;
    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 10) + 10 });
    await delayRandom(400, 800);
    await page.mouse.down();
    await delayRandom(50, 150);
    await page.mouse.up();
};
