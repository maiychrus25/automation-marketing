jest.mock('uuid', () => ({ v4: () => 'id' }));
jest.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
jest.mock('../../services/database/DatabaseService', () => ({ __esModule: true, default: { getInstance: () => ({}) } }));
jest.mock('../../services/integrations/IntegrationRegistry', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/Logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import AIAssistantService from '../../services/ai/AIAssistantService';

describe('AIAssistantService.completeRaw', () => {
  const reply = { result: 'ok', totalTokens: 1, promptTokens: 1, completionTokens: 0 };
  const setup = (assistant: unknown) => {
    const svc = AIAssistantService.getInstance() as any;
    jest.spyOn(svc, 'getAssistant').mockReturnValue(assistant);
    const callLLM = jest.spyOn(svc, 'callLLM').mockResolvedValue(reply);
    const build = jest.spyOn(svc, 'buildSystemPrompt');
    return { svc: svc as AIAssistantService, callLLM, build };
  };
  afterEach(() => jest.restoreAllMocks());

  test('gọi LLM với đúng các tin nhắn đưa vào, không dựng system prompt của trợ lý', async () => {
    const { svc, callLLM, build } = setup({ id: 'a', enabled: true });
    const messages = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'U' }];
    expect(await svc.completeRaw('a', messages, 500)).toBe(reply);
    expect(callLLM).toHaveBeenCalledWith({ id: 'a', enabled: true }, messages, 500);
    expect(build).not.toHaveBeenCalled();
  });
  test('trợ lý không tồn tại hoặc bị tắt thì ném lỗi, không gọi LLM', async () => {
    const missing = setup(null);
    await expect(missing.svc.completeRaw('x', [])).rejects.toThrow('không tồn tại');
    expect(missing.callLLM).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    const off = setup({ id: 'a', enabled: false });
    await expect(off.svc.completeRaw('a', [])).rejects.toThrow('đã bị tắt');
    expect(off.callLLM).not.toHaveBeenCalled();
  });
});
