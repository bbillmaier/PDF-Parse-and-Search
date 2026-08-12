/**
 * Minimal byte-exact PDF builder for Epic B unit fixtures. Not a general
 * PDF writer — just enough to hand-construct small traditional-xref,
 * xref-stream, hybrid, and page-tree documents with known object offsets so
 * TKT-005/006/007/008 tests can assert exact parser behavior, including
 * malformed variants.
 */

export class PdfBuilder {
  private chunks: Buffer[] = [];
  private length = 0;
  private objectOffsets = new Map<number, number>();

  constructor(version = "1.7") {
    this.write(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  }

  get offset(): number {
    return this.length;
  }

  write(text: string): this {
    const buf = Buffer.from(text, "latin1");
    this.chunks.push(buf);
    this.length += buf.byteLength;
    return this;
  }

  writeBytes(bytes: Uint8Array): this {
    const buf = Buffer.from(bytes);
    this.chunks.push(buf);
    this.length += buf.byteLength;
    return this;
  }

  /** Adds "N 0 obj\n<body>\nendobj\n" and records its offset for the xref table. */
  addObject(num: number, body: string): this {
    this.objectOffsets.set(num, this.offset);
    this.write(`${num} 0 obj\n${body}\nendobj\n`);
    return this;
  }

  /** Adds a stream object; `/Length` is computed and appended automatically. `dictOpen` must not include the closing `>>`. */
  addStreamObject(num: number, dictOpen: string, rawBytes: Uint8Array): this {
    this.objectOffsets.set(num, this.offset);
    this.write(`${num} 0 obj\n${dictOpen} /Length ${rawBytes.byteLength} >>\nstream\n`);
    this.writeBytes(rawBytes);
    this.write(`\nendstream\nendobj\n`);
    return this;
  }

  getObjectOffset(num: number): number {
    const offset = this.objectOffsets.get(num);
    if (offset === undefined) throw new Error(`No recorded offset for object ${num}`);
    return offset;
  }

  /** Appends a traditional xref table + trailer + startxref for the given object numbers (0 is always the free head). */
  finalizeTraditional(objNums: number[], trailerBody: string, opts?: { prevOffset?: number }): Buffer {
    const xrefOffset = this.offset;
    const maxObj = Math.max(0, ...objNums);
    this.write(`xref\n0 ${maxObj + 1}\n`);
    for (let n = 0; n <= maxObj; n += 1) {
      if (n === 0) {
        this.write(`0000000000 65535 f \n`);
        continue;
      }
      const off = this.objectOffsets.get(n);
      if (off === undefined) {
        this.write(`0000000000 00000 f \n`);
      } else {
        this.write(`${String(off).padStart(10, "0")} 00000 n \n`);
      }
    }
    const prev = opts?.prevOffset !== undefined ? ` /Prev ${opts.prevOffset}` : "";
    this.write(`trailer\n<< ${trailerBody}${prev} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
    return Buffer.concat(this.chunks);
  }

  /** Raw bytes so far, without finalizing an xref section (for building a /Prev predecessor revision). */
  toBufferSoFar(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Encodes an object-stream header + values body given [{num, value}] pairs; returns {bytes, first}. */
export function buildObjectStreamBody(entries: { num: number; value: string }[]): { bytes: Uint8Array; first: number; n: number } {
  const values = entries.map((e) => e.value);
  const offsets: number[] = [];
  let running = 0;
  for (const v of values) {
    offsets.push(running);
    running += Buffer.byteLength(v + " ", "latin1");
  }
  const header = entries.map((e, i) => `${e.num} ${offsets[i]}`).join(" ") + " ";
  const first = Buffer.byteLength(header, "latin1");
  const body = header + values.join(" ") + " ";
  return { bytes: new Uint8Array(Buffer.from(body, "latin1")), first, n: entries.length };
}
