import { PdfParseError } from "../errors.ts";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(type: Uint8Array, data: Uint8Array): number {
  let c = 0xffffffff;
  for (const bytes of [type, data]) {
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = (value >>> 24) & 0xff;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

function chunk(typeText: string, data: Uint8Array): Uint8Array {
  const type = new TextEncoder().encode(typeText);
  const out = new Uint8Array(12 + data.byteLength);
  writeU32(out, 0, data.byteLength);
  out.set(type, 4);
  out.set(data, 8);
  writeU32(out, 8 + data.byteLength, crc32(type, data));
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== "function") {
    throw new PdfParseError(
      "unsupported-feature",
      "This runtime does not support CompressionStream, so decoded image pixels cannot be encoded as PNG in the worker.",
      "CompressionStream unavailable",
    );
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("deflate") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export async function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Promise<Uint8Array> {
  if (rgba.byteLength !== width * height * 4) {
    throw new PdfParseError("corrupt-structure", "PNG input pixel buffer length does not match width * height * 4.");
  }

  const stride = width * 4;
  const scanlines = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const outOffset = y * (stride + 1);
    scanlines[outOffset] = 0;
    scanlines.set(rgba.subarray(y * stride, y * stride + stride), outOffset + 1);
  }

  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = await deflate(scanlines);
  const parts = [PNG_SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
