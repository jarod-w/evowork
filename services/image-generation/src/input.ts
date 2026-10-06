import { ImageApiError } from '@evowork/gateway';
import { inspectPng } from './png.js';
/** Read dimensions before native decoding, bounding memory even for compressed images. */
export function inspectImageInput(bytes: Buffer): { width: number; height: number } {
  const fail = () => {
    throw new ImageApiError('IMAGE_INPUT_UNSUPPORTED');
  };
  if (bytes.length < 12 || bytes.length > 10 * 1024 * 1024) return fail();
  let width = 0,
    height = 0;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return inspectPng(bytes);
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 255) return fail();
      while (bytes[offset] === 255) offset++;
      const kind = bytes[offset++]!;
      if (kind === 217 || kind === 218) break;
      if (kind === 216 || kind === 1 || (kind >= 208 && kind <= 215)) continue;
      if (offset + 2 > bytes.length) return fail();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return fail();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(kind)) {
        if (length < 8) return fail();
        height = bytes.readUInt16BE(offset + 3);
        width = bytes.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) return fail();
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const kind = bytes.toString('ascii', offset, offset + 4),
        length = bytes.readUInt32LE(offset + 4),
        start = offset + 8;
      if (start + length > bytes.length) return fail();
      if (kind === 'ANIM' || kind === 'ANMF') return fail();
      if (kind === 'VP8X' && length >= 10) {
        if (bytes[start]! & 2) return fail();
        width = 1 + bytes.readUIntLE(start + 4, 3);
        height = 1 + bytes.readUIntLE(start + 7, 3);
      }
      if (kind === 'VP8L' && length >= 5 && bytes[start] === 47) {
        const bits = bytes.readUInt32LE(start + 1);
        width = (bits & 16383) + 1;
        height = ((bits >>> 14) & 16383) + 1;
      }
      if (
        kind === 'VP8 ' &&
        length >= 10 &&
        bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))
      ) {
        width = bytes.readUInt16LE(start + 6) & 16383;
        height = bytes.readUInt16LE(start + 8) & 16383;
      }
      if (width * height > 16_000_000) return fail();
      offset = start + length + (length & 1);
    }
  } else return fail();
  if (!width || !height || width * height > 16_000_000) return fail();
  return { width, height };
}
