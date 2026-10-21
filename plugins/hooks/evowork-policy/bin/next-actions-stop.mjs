/** Optional, bounded same-turn reminder. Never read the kernel transcript or forward response text. */
export async function checkNextActionsStop(input, environment = process.env, request = fetch) {
  if (
    input.hook_event_name !== 'Stop' ||
    input.stop_hook_active !== false ||
    typeof input.session_id !== 'string' ||
    typeof input.turn_id !== 'string' ||
    !environment.EVOWORK_NEXT_ACTIONS_ENDPOINT ||
    !environment.EVOWORK_NEXT_ACTIONS_TOKEN
  )
    return {};
  try {
    const endpoint = new URL(environment.EVOWORK_NEXT_ACTIONS_ENDPOINT);
    if (
      endpoint.protocol !== 'http:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== '/call'
    )
      return {};
    endpoint.pathname = '/stop';
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + environment.EVOWORK_NEXT_ACTIONS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: input.session_id,
        turnId: input.turn_id,
        stopHookActive: false,
      }),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) return {};
    const result = await response.json();
    return result?.decision === 'block' && typeof result.reason === 'string' && result.reason.trim()
      ? { decision: 'block', reason: result.reason }
      : {};
  } catch {
    return {};
  }
}
if (process.env.EVOWORK_NEXT_ACTIONS_LIBRARY !== '1') {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Input too large');
      chunks.push(chunk);
    }
    const result = await checkNextActionsStop(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    process.stdout.write('{}\n');
  }
}
