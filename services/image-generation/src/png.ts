import { inflateSync } from 'node:zlib';
import { ImageApiError, IMAGE_MAX_BYTES } from '@evowork/gateway';
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc(bytes: Buffer) {
  let value = 0xffffffff;
  for (const b of bytes) value = table[(value ^ b) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
/** Reject truncated PNGs, APNG, invalid checksums, decompression bombs and unsupported interlace. */
export function inspectPng(bytes: Buffer): { width: number; height: number } {
  const bad = () => {
    throw new ImageApiError('IMAGE_INVALID_PNG');
  };
  if (
    bytes.length < 45 ||
    bytes.length > IMAGE_MAX_BYTES ||
    !bytes.subarray(0, 8).equals(signature)
  )
    return bad();
  let width = 0,
    height = 0,
    rowBytes = 0,
    offset = 8,
    ended = false;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return bad();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return bad();
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (
      crc(bytes.subarray(offset + 4, offset + 8 + length)) !==
      bytes.readUInt32BE(offset + 8 + length)
    )
      return bad();
    if (offset === 8 && kind !== 'IHDR') return bad();
    if (kind === 'IHDR') {
      if (width || length !== 13) return bad();
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      const depth = chunk[8]!,
        color = chunk[9]!;
      if (
        !width ||
        !height ||
        width * height > 16_000_000 ||
        !channels[color] ||
        ![1, 2, 4, 8, 16].includes(depth) ||
        (color !== 0 && color !== 3 && depth < 8) ||
        (color === 3 && depth === 16) ||
        chunk[10] !== 0 ||
        chunk[11] !== 0 ||
        chunk[12] !== 0
      )
        return bad();
      rowBytes = Math.ceil((width * channels[color]! * depth) / 8);
    } else if (kind === 'IDAT') data.push(chunk);
    else if (kind === 'IEND') {
      if (length || offset + 12 !== bytes.length) return bad();
      ended = true;
    } else if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') return bad();
    offset += length + 12;
  }
  if (!ended || !data.length) return bad();
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: (rowBytes + 1) * height + 1 });
  } catch {
    return bad();
  }
  if (raw.length !== (rowBytes + 1) * height) return bad();
  for (let i = 0; i < height; i++) if (raw[i * (rowBytes + 1)]! > 4) return bad();
  return { width, height };
}
