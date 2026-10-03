import type { BrowserContext } from 'playwright-core';

export const FB_HOME = 'https://www.facebook.com/';

/** Cookie c_user là dấu hiệu đáng tin nhất cho việc đã đăng nhập. */
export async function isLoggedIn(ctx: Pick<BrowserContext, 'cookies'>): Promise<boolean> {
    const cookies = await ctx.cookies(FB_HOME);
    return cookies.some(c => c.name === 'c_user' && !!c.value);
}
