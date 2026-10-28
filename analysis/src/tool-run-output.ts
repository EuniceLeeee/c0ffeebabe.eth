import { createHash } from "node:crypto";
import { Transform, type Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { redactToolOutput, toolOutputSecretReplacements } from "./tool-run-security.js";

function safeEnd(text: string, end: number): number {
  return end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end] ?? "") ? end - 1 : end;
}

// A URL is one token, but can be arbitrarily long. Keep only enough to recognize
// an allowed loopback URL; all longer candidates are redacted and discarded up
// to their delimiter. This avoids buffering a giant unbroken output line.
class UrlRedactor extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private droppingUrl = false;

  constructor() { super({ readableObjectMode: true }); }

  private consume(text: string, final: boolean): void {
    let remaining = this.pending + text;
    this.pending = "";
    while (remaining) {
      if (this.droppingUrl) {
        const end = remaining.search(/[\s"'`<>]/);
        if (end < 0) return;
        remaining = remaining.slice(end);
        this.droppingUrl = false;
      }
      const start = /(?:https?|wss?):\/\//i.exec(remaining);
      if (!start) {
        // The longest supported prefix is eight characters (https://).
        const end = final ? remaining.length : safeEnd(remaining, Math.max(0, remaining.length - 7));
        this.push(remaining.slice(0, end));
        this.pending = remaining.slice(end);
        return;
      }
      this.push(remaining.slice(0, start.index));
      remaining = remaining.slice(start.index);
      const end = remaining.search(/[\s"'`<>]/);
      if (end >= 0 || final) {
        const length = end < 0 ? remaining.length : end;
        this.push(redactToolOutput(remaining.slice(0, length), {}));
        remaining = remaining.slice(length);
      } else if (remaining.length > 128) {
        this.push("<redacted-url>");
        this.droppingUrl = true;
        return;
      } else {
        this.pending = remaining;
        return;
      }
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.consume(this.decoder.write(chunk), false);
    callback();
  }
  override _flush(callback: (error?: Error | null) => void): void {
    this.consume(this.decoder.end(), true);
    callback();
  }
}

/** One bounded carry per literal preserves the existing ordered replacements,
 * even for multi-line credentials or matches split across UTF-8/RPC chunks. */
class LiteralRedactor extends Transform {
  private pending = "";
  constructor(private readonly value: string, private readonly replacement: string) {
    super({ objectMode: true });
  }
  override _transform(chunk: string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    let text = this.pending + chunk;
    let index: number;
    while ((index = text.indexOf(this.value)) >= 0) {
      this.push(text.slice(0, index) + this.replacement);
      text = text.slice(index + this.value.length);
    }
    const end = safeEnd(text, Math.max(0, text.length - this.value.length + 1));
    this.push(text.slice(0, end));
    this.pending = text.slice(end);
    callback();
  }
  override _flush(callback: (error?: Error | null) => void): void {
    this.push(this.pending);
    callback();
  }
}

/** Hash/count original bytes, forward only redacted text, and honor downstream
 * backpressure. The destination is shared process stdout/stderr, not ours to end. */
export async function forwardToolOutput(source: Readable, destination: Writable, env = process.env): Promise<{
  bytes: number; sha256: string;
}> {
  const hash = createHash("sha256");
  let bytes = 0;
  const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    hash.update(chunk);
    bytes += chunk.length;
    callback(null, chunk);
  } });
  const replacements = toolOutputSecretReplacements(env).map(({ value, replacement }) => new LiteralRedactor(value, replacement));
  await pipeline([source, measure, new UrlRedactor(), ...replacements, destination], { end: false });
  return { bytes, sha256: hash.digest("hex") };
}
