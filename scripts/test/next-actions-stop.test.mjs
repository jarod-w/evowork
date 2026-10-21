import { afterAll, expect, it, vi } from 'vitest';
const previous = process.env.EVOWORK_NEXT_ACTIONS_LIBRARY;
process.env.EVOWORK_NEXT_ACTIONS_LIBRARY = '1';
const { checkNextActionsStop } =
  await import('../../plugins/hooks/evowork-policy/bin/next-actions-stop.mjs');
afterAll(() => {
  if (previous === undefined) delete process.env.EVOWORK_NEXT_ACTIONS_LIBRARY;
  else process.env.EVOWORK_NEXT_ACTIONS_LIBRARY = previous;
});
const input = {
  hook_event_name: 'Stop',
  session_id: 'task',
  turn_id: 'turn',
  stop_hook_active: false,
  transcript_path: '/private/kernel/transcript',
  last_assistant_message: 'private final response',
};
const env = {
  EVOWORK_NEXT_ACTIONS_ENDPOINT: 'http://127.0.0.1:1234/call',
  EVOWORK_NEXT_ACTIONS_TOKEN: 'local-test-token',
};
it('仅发送当前回合身份，不读取或转发内核历史路径和回复正文', async () => {
  const request = vi
    .fn()
    .mockResolvedValue(Response.json({ decision: 'block', reason: 'one reminder' }));
  expect(await checkNextActionsStop(input, env, request)).toEqual({
    decision: 'block',
    reason: 'one reminder',
  });
  const [url, options] = request.mock.calls[0];
  expect(String(url)).toBe('http://127.0.0.1:1234/stop');
  expect(JSON.parse(options.body)).toEqual({
    threadId: 'task',
    turnId: 'turn',
    stopHookActive: false,
  });
  expect(JSON.stringify(options)).not.toContain(input.transcript_path);
  expect(JSON.stringify(options)).not.toContain(input.last_assistant_message);
});
it('重入、非 Stop、无令牌或非本机地址均不发请求', async () => {
  const request = vi.fn();
  for (const value of [
    { ...input, stop_hook_active: true },
    { ...input, hook_event_name: 'SubagentStop' },
    { ...input, turn_id: null },
  ])
    expect(await checkNextActionsStop(value, env, request)).toEqual({});
  expect(await checkNextActionsStop(input, {}, request)).toEqual({});
  expect(
    await checkNextActionsStop(
      input,
      { ...env, EVOWORK_NEXT_ACTIONS_ENDPOINT: 'https://example.com/call' },
      request,
    ),
  ).toEqual({});
  expect(request).not.toHaveBeenCalled();
});
it('服务离线、令牌失效或无效结果直接放行，不阻塞当前交付', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response('', { status: 403 }))
    .mockResolvedValueOnce(Response.json({ decision: 'block', reason: '' }))
    .mockResolvedValueOnce(Response.json({}));
  for (let i = 0; i < 4; i++) expect(await checkNextActionsStop(input, env, request)).toEqual({});
});
