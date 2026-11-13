import { FacebookMQTTListener } from '../../services/facebook/FacebookMQTTListener';

const story = {
  title_with_entities: { text: 'Tiêu đề mẫu' },
  description: { text: 'Mô tả mẫu' },
  action_links: [{ title: 'Xem ngay', url: 'https://example.com/a' }],
};
const TEMPLATE_BODY = 'Tiêu đề mẫu\nMô tả mẫu\n• Xem ngay — https://example.com/a';

function parse(delta: Record<string, any>): any[] {
  const listener = new FacebookMQTTListener({} as any, 'acc-template');
  const out: any[] = [];
  listener.on('message', (m) => out.push(m));
  (listener as any).processDelta({
    messageMetadata: { threadKey: { otherUserFbId: '100200300' }, messageId: 'mid.t1', actorFbId: '100200300', timestamp: '1000' },
    ...delta,
  });
  return out;
}

describe('template message from MQTT delta', () => {
  test('noBodyBecomesPlainTextWithTemplateText', () => {
    const [m] = parse({ attachments: [{ id: 'a1', mercury: { extensible_attachment: { story_attachment: story } } }] });
    expect(m.body).toBe(TEMPLATE_BODY);
    expect(m.attachments).toEqual({ id: 0, url: null });
    expect(m.allAttachments).toBeUndefined();
  });

  test('existingBodyKept', () => {
    const [m] = parse({ body: 'Chữ có sẵn', attachments: [{ id: 'a1', mercury: { extensible_attachment: { story_attachment: story } } }] });
    expect(m.body).toBe('Chữ có sẵn');
  });

  test('emptyTemplateKeepsTodaysBehavior', () => {
    const [m] = parse({ attachments: [{ id: 'a1', mercury: { extensible_attachment: { story_attachment: {} } } }] });
    expect(m.body).toBeNull();
    expect(m.attachments.id).toBe('a1');
  });

  test('blobAttachmentIsNotATemplate', () => {
    const [m] = parse({ attachments: [{ id: 'a1', mercury: {
      blob_attachment: { __typename: 'MessagePhoto', large_preview: { uri: 'https://example.com/i.jpg' } },
      extensible_attachment: { story_attachment: story },
    } }] });
    expect(m.body).toBeNull();
    expect(m.attachments.attachmentType).toBe('image');
  });

  test('realMediaKeptAlongsideTemplateText', () => {
    const [m] = parse({ attachments: [
      { id: 'a1', mercury: { extensible_attachment: { story_attachment: story } } },
      { id: 'a2', mercury: { blob_attachment: { __typename: 'MessagePhoto', large_preview: { uri: 'https://example.com/i.jpg' } } } },
    ] });
    expect(m.body).toBe(TEMPLATE_BODY);
    expect(m.attachments.attachmentType).toBe('image');
    expect(m.allAttachments).toBeUndefined();
  });
});
