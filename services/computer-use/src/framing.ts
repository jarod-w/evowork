/** 本机传输：4 字节大端长度 + UTF-8 JSON。禁止无界缓冲截图或畸形帧。 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME_BYTES) throw new Error('FRAME_TOO_LARGE');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
export class FrameDecoder {
  private buffered: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const frames: unknown[] = [];
    while (this.buffered.length >= 4) {
      const size = this.buffered.readUInt32BE();
      if (size === 0 || size > MAX_FRAME_BYTES) throw new Error('INVALID_FRAME');
      if (this.buffered.length < size + 4) break;
      frames.push(JSON.parse(this.buffered.subarray(4, size + 4).toString('utf8')) as unknown);
      this.buffered = this.buffered.subarray(size + 4);
    }
    if (this.buffered.length > MAX_FRAME_BYTES + 4) throw new Error('INVALID_FRAME');
    return frames;
  }
}
