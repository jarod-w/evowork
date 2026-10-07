import { expect, it, vi } from 'vitest';
import { generateImage, imageModelId, IMAGE_MODELS, IMAGE_API_BASE } from '../src/images.js';
const input = { model: IMAGE_MODELS[0].id, prompt: 'a cat' };
const config = { baseUrl: IMAGE_API_BASE, apiKey: 'test-only-key' };
it('temporarily removed Lite IDs cannot issue a provider request', async () => {
  const fetchImpl = vi.fn();
  for (const model of ['Doubao-Seedream-5.0-lite', 'doubao-seedream-5-0-260128']) {
    await expect(
      generateImage({ ...config, fetchImpl }, { ...input, model }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'IMAGE_MODEL_UNSUPPORTED', outcomeUnknown: false });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('remaining Flash and Pro aliases resolve to their own provider IDs', () => {
  expect(imageModelId('Doubao-Seedream-5.0-flash')).toBe('doubao-seedream-5-0-flash-260915');
  expect(imageModelId('Doubao-Seedream-5.0-pro')).toBe('doubao-seedream-5-0-pro-260628');
});
it('one generation/edit POST with no redirects, retries or model switching', async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ data: [{ b64_json: 'aGVsbG8=' }], usage: { generated_images: 1 } }),
        { status: 200 },
      ),
  );
  const result = await generateImage(
    { ...config, fetchImpl },
    { ...input, image: 'data:image/png;base64,aGVsbG8=' },
    new AbortController().signal,
  );
  expect(result.b64).toBe('aGVsbG8=');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const args = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
  expect(String(args[0])).toBe(IMAGE_API_BASE + 'images/generations');
  expect(args[1].redirect).toBe('error');
  expect(JSON.parse(args[1].body as string)).toMatchObject({
    model: input.model,
    image: 'data:image/png;base64,aGVsbG8=',
    size: '2K',
    output_format: 'png',
    response_format: 'b64_json',
    stream: false,
    watermark: true,
  });
});
it.each([401, 403, 429, 500])('provider error %i is redacted and never retried', async (status) => {
  const fetchImpl = vi.fn(async () => new Response('SECRET prompt and provider body', { status }));
  await expect(
    generateImage({ ...config, fetchImpl }, input, new AbortController().signal),
  ).rejects.toMatchObject({ outcomeUnknown: status >= 500 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it('unknown network failure and malformed successful response are uncertain, no retries', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('secret network detail');
  });
  await expect(
    generateImage({ ...config, fetchImpl }, input, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'IMAGE_OUTCOME_UNKNOWN', outcomeUnknown: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(
    generateImage(
      { ...config, fetchImpl: async () => new Response('{bad') },
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ outcomeUnknown: true });
});
it('reject unsupported models, arbitrary input URLs and managed denial before fetch', async () => {
  const fetchImpl = vi.fn();
  for (const raw of [
    { ...input, model: 'anything' },
    { ...input, image: 'https://example.com/image.png' },
    { ...input, mask: 'x' },
  ])
    await expect(
      generateImage({ ...config, fetchImpl }, raw, new AbortController().signal),
    ).rejects.toThrow();
  await expect(
    generateImage({ ...config, fetchImpl, denied: true }, input, new AbortController().signal),
  ).rejects.toThrow('IMAGE_POLICY_DENIED');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('HTTP image routes authenticate locally, verify only directory and never leak provider credentials', async () => {
  const { createGatewayServer } = await import('../src/server.js');
  const fetchImpl = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/models')
            ? { data: [{ id: IMAGE_MODELS[0].id }], secret: 'provider-private-detail' }
            : { data: [{ b64_json: 'aGVsbG8=' }] },
        ),
      ),
  );
  const server = createGatewayServer({
    models: { find: () => undefined, list: () => [] },
    providers: {},
    configFor: () => config,
    authenticate: (authorization) => authorization === 'Bearer local-token',
    imageProvider: { ...config, fetchImpl },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  const base = `http://127.0.0.1:${address.port}/v1/evowork/`;
  try {
    for (const route of ['image-models', 'image-operations']) {
      const result = await fetch(base + route, {
        method: route === 'image-models' ? 'GET' : 'POST',
      });
      expect(result.status).toBe(401);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const headers = { Authorization: 'Bearer local-token', 'Content-Type': 'application/json' };
    const directory = await fetch(base + 'image-models', { headers });
    const text = await directory.text();
    expect(directory.status).toBe(200);
    expect(text).not.toContain(config.apiKey);
    expect(text).not.toContain('provider-private-detail');
    expect(JSON.parse(text).models).toEqual([
      expect.objectContaining({ id: 'doubao-seedream-5-0-flash-260915', available: true }),
      expect.objectContaining({ id: 'doubao-seedream-5-0-pro-260628', available: false }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const result = await fetch(base + 'image-operations', {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ b64: 'aGVsbG8=' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
