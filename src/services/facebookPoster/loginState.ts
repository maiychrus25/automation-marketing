import type { BrowserContext } from 'playwright-core';

export const FB_HOME = 'https://www.facebook.com/';
export const NOT_LOGGED_IN_ERROR = 'Profile chưa đăng nhập Facebook. Mở profile ở màn hình Trình duyệt để đăng nhập';
export const CHECKPOINT_MESSAGE = 'Facebook yêu cầu xác minh tài khoản (checkpoint). Mở profile để xác minh rồi đăng lại.';

/** Cookie c_user là dấu hiệu đáng tin nhất cho việc đã đăng nhập. */
export async function isLoggedIn(ctx: Pick<BrowserContext, 'cookies'>): Promise<boolean> {
    const cookies = await ctx.cookies(FB_HOME);
    return cookies.some(c => c.name === 'c_user' && !!c.value);
}
