import { FacebookPageBrowserSender, PageInboxDriver } from '../../services/facebook/FacebookPageBrowserSender';

class FakeDriver implements PageInboxDriver {
  calls: string[] = [];
  failOpen = false;
  failWait = false;
  active = 0;
  maxActive = 0;
  async openThread(id: string): Promise<void> {
    if (this.failOpen) throw new Error('auth');
    this.calls.push('open:' + id);
  }
  async sendText(t: string): Promise<void> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 5));
    this.active--;
    this.calls.push('text:' + t);
  }
  async attachFiles(p: string[]): Promise<void> {
    this.calls.push('files:' + p.length);
  }
  async waitSent(): Promise<void> {
    if (this.failWait) throw new Error('timeout chờ xác nhận');
    this.calls.push('sent');
  }
  async readIncomingMedia(): Promise<{ type: 'image' | 'video'; url: string }[]> {
    return [];
  }
  stickers: { label: string; thumbUrl: string }[] = [{ label: 'a sticker', thumbUrl: 'u1' }];
  async listStickers(id: string, kw: string): Promise<{ label: string; thumbUrl: string }[]> {
    this.calls.push('list:' + id + ':' + kw);
    return this.stickers;
  }
  async sendSticker(id: string, kw: string, index: number): Promise<void> {
    if (this.failWait) throw new Error('timeout chờ xác nhận');
    this.calls.push('sticker:' + id + ':' + kw + ':' + index);
  }
}

describe('FacebookPageBrowserSender', () => {
  it('gửi text thành công: open → text → sent', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    const r = await s.send('123', { text: 'hi' });
    expect(r.success).toBe(true);
    expect(r.messageId).toBeTruthy();
    expect(d.calls).toEqual(['open:123', 'text:hi', 'sent']);
  });

  it('đính kèm trước khi gửi: open → files → text → sent', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    const r = await s.send('1', { text: 'caption', files: [{ path: '/a.png', type: 'image' }] });
    expect(r.success).toBe(true);
    expect(d.calls).toEqual(['open:1', 'files:1', 'text:caption', 'sent']);
  });

  it('lỗi auth khi mở hội thoại → success=false, error nêu Business Suite', async () => {
    const d = new FakeDriver();
    d.failOpen = true;
    const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).send('1', { text: 'a' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Business Suite/);
  });

  it('timeout chờ xác nhận → success=false', async () => {
    const d = new FakeDriver();
    d.failWait = true;
    const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).send('1', { text: 'a' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/xác nhận|timeout/);
  });

  it('input rỗng → lỗi, không gọi driver gửi', async () => {
    const d = new FakeDriver();
    const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).send('1', {});
    expect(r.success).toBe(false);
    expect(d.calls).toEqual([]);
  });

  it('hai send song song tới cùng Page nối tiếp (mutex)', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    await Promise.all([s.send('1', { text: 'a' }), s.send('2', { text: 'b' })]);
    expect(d.maxActive).toBe(1);
  });

  it('listStickers: open ngầm + trả danh sách', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    const r = await s.listStickers('123', 'vui', 20);
    expect(r).toEqual([{ label: 'a sticker', thumbUrl: 'u1' }]);
    expect(d.calls).toContain('list:123:vui');
  });

  it('sendSticker: open → sticker, success', async () => {
    const d = new FakeDriver();
    const s = new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' });
    const r = await s.sendSticker('123', 'vui', 0);
    expect(r.success).toBe(true);
    expect(d.calls).toEqual(['open:123', 'sticker:123:vui:0']);
  });

  it('sendSticker lỗi → success=false, error Business Suite', async () => {
    const d = new FakeDriver(); d.failWait = true;
    const r = await new FacebookPageBrowserSender({ driver: d, delegatePageId: 'X' }).sendSticker('1', 'vui', 0);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Business Suite/);
  });
});
