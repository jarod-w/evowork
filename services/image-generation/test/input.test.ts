import { expect, it } from 'vitest';
import { inspectImageInput } from '../src/input.js';
function jpeg(width: number, height: number) {
  const bytes = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 0, 0, 0, 1, 255, 217]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}
function webp(width: number, height: number, animated = false) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8X', 8);
  bytes.writeUInt32LE(10, 16);
  bytes[20] = animated ? 2 : 0;
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}
it('bounds JPEG and WebP dimensions before any native decoder runs', () => {
  expect(inspectImageInput(jpeg(2048, 2048))).toEqual({ width: 2048, height: 2048 });
  expect(inspectImageInput(webp(2048, 2048))).toEqual({ width: 2048, height: 2048 });
  expect(() => inspectImageInput(jpeg(65535, 65535))).toThrow();
  expect(() => inspectImageInput(webp(1000000, 1000000))).toThrow();
});
it('rejects animated, truncated, unsupported and oversized source bytes', () => {
  expect(() => inspectImageInput(webp(100, 100, true))).toThrow();
  expect(() => inspectImageInput(webp(100, 100).subarray(0, -1))).toThrow();
  expect(() => inspectImageInput(Buffer.from('GIF89a0000000000'))).toThrow();
  expect(() => inspectImageInput(Buffer.alloc(10 * 1024 * 1024 + 1))).toThrow();
});
