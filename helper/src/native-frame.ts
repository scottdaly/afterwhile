import { NATIVE_MESSAGE_MAX_BYTES } from "../../shared/src/index.ts";

export class NativeDecoder {
  private buf = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.buf = Buffer.concat([this.buf, Buffer.from(chunk)]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > NATIVE_MESSAGE_MAX_BYTES) {
        throw new Error("native message exceeds 1MB");
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body.toString("utf8")));
    }
    return out;
  }
}

export function encodeNative(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > NATIVE_MESSAGE_MAX_BYTES) {
    throw new Error("native message exceeds 1MB");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
