/**
 * Danh tính trình duyệt duy nhất cho mọi yêu cầu MaiHub gửi tới Facebook bằng cookie của người dùng.
 * Một phiên đăng nhập thuộc về một trình duyệt: gửi cùng cookie với nhiều chuỗi trình duyệt khác nhau là dấu hiệu bất thường.
 * Giá trị trùng với danh tính mà bridge Go dùng (hằng số trong `pkg/messagix/useragent` của mautrix-meta ở commit đang ghim
 * trong `scripts/build-bridge-e2ee.js`); khi nâng commit đó thì cập nhật ở đây cho khớp.
 */
const CHROME_MAJOR = '141';

export const FB_USER_AGENT = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
export const FB_SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not-A.Brand";v="99"`;
export const FB_SEC_CH_UA_PLATFORM = '"Linux"';
