/**
 * Khi echo của tin tự gửi thay tin tạm: giữ `localPath` của tin thật; chỉ khi tin thật chưa có
 * thì dùng đường dẫn của tin tạm (theo từng vị trí). Đường dẫn tạm nằm trên máy gửi nên không được ghi đè đường dẫn thật.
 */
export function mergeTempAttachments(tempJson: string | undefined, realJson: string | undefined): string | undefined {
    try {
        const tempAtts = JSON.parse(tempJson || '[]');
        const realAtts = JSON.parse(realJson || '[]');
        if (!Array.isArray(tempAtts) || !Array.isArray(realAtts) || realAtts.length === 0) return realJson;
        let changed = false;
        realAtts.forEach((att, i) => {
            const tempPath = tempAtts[i]?.localPath;
            if (att && !att.localPath && tempPath) { att.localPath = tempPath; changed = true; }
        });
        return changed ? JSON.stringify(realAtts) : realJson;
    } catch {
        return realJson;
    }
}
