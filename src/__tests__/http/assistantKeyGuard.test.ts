import { checkAssistantHostChange, MASKED_API_KEY } from '../../services/http/assistantKeyGuard';

const stored = { platform: 'openai', baseUrl: 'https://api.example.com/v1' };
const KEY_REQUIRED = { ok: false, code: 'KEY_REQUIRED', error: 'Đổi địa chỉ máy chủ AI thì phải nhập lại khoá API' };

describe('checkAssistantHostChange', () => {
  test('keepingTheKeyWithTheSameHostIsAllowed', () => {
    expect(checkAssistantHostChange({ apiKey: MASKED_API_KEY, platform: 'openai', baseUrl: 'https://api.example.com/v1' }, stored)).toEqual({ ok: true });
    expect(checkAssistantHostChange({ apiKey: MASKED_API_KEY, platform: 'openai', baseUrl: ' https://api.example.com/v1/ ' }, stored)).toEqual({ ok: true });
  });
  test('keepingTheKeyWithAnotherBaseUrlOrPlatformIsRefused', () => {
    expect(checkAssistantHostChange({ apiKey: '***', platform: 'openai', baseUrl: 'https://evil.test' }, stored)).toEqual(KEY_REQUIRED);
    expect(checkAssistantHostChange({ apiKey: '***', platform: 'gemini', baseUrl: 'https://api.example.com/v1' }, stored)).toEqual(KEY_REQUIRED);
    expect(checkAssistantHostChange({ apiKey: '***', platform: 'openai' }, stored)).toEqual(KEY_REQUIRED);
    expect(checkAssistantHostChange({ apiKey: '***', platform: 'openai', baseUrl: 'https://api.example.com/v1' }, { platform: 'openai', baseUrl: null })).toEqual(KEY_REQUIRED);
  });
  test('noBaseUrlOnBothSidesIsTheSameHost', () => {
    expect(checkAssistantHostChange({ apiKey: '***', platform: 'openai', baseUrl: '' }, { platform: 'openai', baseUrl: null })).toEqual({ ok: true });
  });
  test('aNewRealKeyMayChangeTheHost', () => {
    expect(checkAssistantHostChange({ apiKey: 'sk-new', platform: 'openai', baseUrl: 'https://other.test' }, stored)).toEqual({ ok: true });
  });
  test('anAssistantThatIsNotStoredHasNoKeyToKeep', () => {
    expect(checkAssistantHostChange({ apiKey: '***', platform: 'openai', baseUrl: 'https://other.test' }, null)).toEqual({ ok: true });
  });
});
