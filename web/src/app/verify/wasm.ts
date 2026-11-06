// Wasm helpers for the verify page. Pure functions, no I/O.
//
// The registry embeds the vault wasm with `include_bytes!`, so the vault's bytes sit in the
// registry's data section. The linker and wasm-opt may split that blob into several data segments
// (runs of zero bytes are dropped), so a plain substring search over the registry file can miss it.
// `embeddedIn` rebuilds the linear memory the active segments initialize and searches that.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';

/** The `code_hash` NEAR reports in `view_account`: base58 of the sha256 of the wasm. */
export function nearCodeHash(wasm: Uint8Array): string {
  return base58.encode(sha256(wasm));
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** `view_account.code_hash` of an account with no contract. */
export const EMPTY_CODE_HASH = '11111111111111111111111111111111';

class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    const b = this.bytes[this.pos++];
    if (b === undefined) throw new Error('wasm: unexpected end of input');
    return b;
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 35) throw new Error('wasm: LEB128 too long');
    }
  }

  /** Signed LEB128, enough for i32.const offsets. */
  s32(): number {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    if (shift < 32 && b & 0x40) result |= -1 << shift;
    return result;
  }

  take(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    if (out.length !== n) throw new Error('wasm: segment runs past the end of the file');
    this.pos += n;
    return out;
  }
}

interface Segment {
  /** Memory offset for an active segment, null for a passive one. */
  offset: number | null;
  bytes: Uint8Array;
}

const DATA_SECTION = 11;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** Data segments of a wasm module. Throws on a file that is not wasm. */
export function dataSegments(wasm: Uint8Array): Segment[] {
  if (WASM_MAGIC.some((b, i) => wasm[i] !== b)) throw new Error('wasm: bad magic number');
  const r = new Reader(wasm);
  r.pos = 8;
  const segments: Segment[] = [];
  while (r.pos < wasm.length) {
    const id = r.byte();
    const size = r.u32();
    const end = r.pos + size;
    if (id !== DATA_SECTION) {
      r.pos = end;
      continue;
    }
    const count = r.u32();
    for (let i = 0; i < count; i++) {
      const flags = r.u32();
      let offset: number | null = null;
      if (flags === 0 || flags === 2) {
        if (flags === 2) r.u32(); // memory index
        const op = r.byte();
        if (op !== 0x41) throw new Error(`wasm: unsupported data offset opcode 0x${op.toString(16)}`);
        offset = r.s32() >>> 0;
        if (r.byte() !== 0x0b) throw new Error('wasm: data offset expression not terminated');
      } else if (flags !== 1) {
        throw new Error(`wasm: unknown data segment flags ${flags}`);
      }
      const length = r.u32();
      segments.push({ offset, bytes: r.take(length) });
    }
    r.pos = end;
  }
  return segments;
}

/** The bytes active data segments write into linear memory, from the lowest offset to the highest end. */
export function initializedMemory(wasm: Uint8Array): Uint8Array {
  const active = dataSegments(wasm).filter((s): s is Segment & { offset: number } => s.offset !== null);
  if (active.length === 0) return new Uint8Array(0);
  const start = Math.min(...active.map((s) => s.offset));
  const end = Math.max(...active.map((s) => s.offset + s.bytes.length));
  const memory = new Uint8Array(end - start);
  for (const s of active) memory.set(s.bytes, s.offset - start);
  return memory;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  const first = needle[0];
  const last = haystack.length - needle.length;
  outer: for (let i = haystack.indexOf(first as number); i !== -1 && i <= last; i = haystack.indexOf(first as number, i + 1)) {
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * True when `inner` appears byte for byte in `outer`'s initialized memory or in one of its passive
 * segments. Used to check that a vault runs exactly the code its registry deploys.
 */
export function embeddedIn(outer: Uint8Array, inner: Uint8Array): boolean {
  if (indexOf(initializedMemory(outer), inner) !== -1) return true;
  return dataSegments(outer).some((s) => s.offset === null && indexOf(s.bytes, inner) !== -1);
}
