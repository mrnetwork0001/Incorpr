#!/usr/bin/env python3
"""Fail if a contract wasm imports a host function the target NEAR network does not provide.

Mainnet (protocol 87) runs with wasm_config.universal_accounts = false, so a contract that imports
promise_batch_action_universal_state_init is rejected at deploy time. Testnet accepts it, which
hides the problem until the mainnet deploy.

Usage:
  scripts/check-wasm-imports.py [--list] [--deny NAME ...] FILE.wasm [FILE.wasm ...]

Exit codes: 0 = no denied imports, 1 = a denied import was found, 2 = unreadable or malformed wasm.
Pure python, no dependencies.
"""
import argparse
import sys

# Host functions gated behind runtime features that mainnet does not enable today.
DEFAULT_DENY = (
    "promise_batch_action_universal_state_init",
)

WASM_MAGIC = b"\x00asm"
SECTION_IMPORT = 2
KIND_NAMES = {0: "func", 1: "table", 2: "memory", 3: "global", 4: "tag"}


class WasmError(Exception):
    pass


class Reader:
    def __init__(self, data, pos=0, end=None):
        self.data = data
        self.pos = pos
        self.end = len(data) if end is None else end

    def byte(self):
        if self.pos >= self.end:
            raise WasmError("unexpected end of data at offset %d" % self.pos)
        b = self.data[self.pos]
        self.pos += 1
        return b

    def u32(self):
        result = 0
        shift = 0
        for _ in range(5):
            b = self.byte()
            result |= (b & 0x7F) << shift
            if not b & 0x80:
                return result
            shift += 7
        raise WasmError("LEB128 u32 too long at offset %d" % self.pos)

    def bytes(self, n):
        if self.pos + n > self.end:
            raise WasmError("length %d overruns section at offset %d" % (n, self.pos))
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out

    def name(self):
        return self.bytes(self.u32()).decode("utf-8")

    def limits(self):
        flags = self.byte()
        self.u32()
        if flags & 0x01:
            self.u32()


def read_imports(data):
    """Return a list of (module, field, kind) tuples from the wasm import section."""
    if data[:4] != WASM_MAGIC:
        raise WasmError("not a wasm module (bad magic)")
    if len(data) < 8:
        raise WasmError("truncated header")
    r = Reader(data, 8)
    imports = []
    while r.pos < r.end:
        section_id = r.byte()
        size = r.u32()
        start = r.pos
        if section_id == SECTION_IMPORT:
            s = Reader(data, start, start + size)
            for _ in range(s.u32()):
                module = s.name()
                field = s.name()
                kind = s.byte()
                if kind == 0:  # func: type index
                    s.u32()
                elif kind == 1:  # table: reftype + limits
                    s.byte()
                    s.limits()
                elif kind == 2:  # memory: limits
                    s.limits()
                elif kind == 3:  # global: valtype + mutability
                    s.byte()
                    s.byte()
                elif kind == 4:  # tag: attribute + type index
                    s.byte()
                    s.u32()
                else:
                    raise WasmError("unknown import kind %d" % kind)
                imports.append((module, field, KIND_NAMES[kind]))
        r.pos = start + size
        if r.pos > r.end:
            raise WasmError("section %d overruns file" % section_id)
    return imports


def main(argv):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("files", nargs="+", metavar="FILE.wasm")
    p.add_argument("--deny", action="append", default=[],
                   help="additional import name to reject (repeatable)")
    p.add_argument("--list", action="store_true", help="print every import")
    args = p.parse_args(argv)

    deny = set(DEFAULT_DENY) | set(args.deny)
    status = 0
    for path in args.files:
        try:
            with open(path, "rb") as f:
                imports = read_imports(f.read())
        except (OSError, WasmError, UnicodeDecodeError) as e:
            print("%s: error: %s" % (path, e), file=sys.stderr)
            status = max(status, 2)
            continue
        if args.list:
            for module, field, kind in imports:
                print("%s: import %s %s.%s" % (path, kind, module, field))
        bad = [(m, f) for m, f, _ in imports if f in deny]
        if bad:
            for module, field in bad:
                print("%s: DENIED import %s.%s" % (path, module, field))
            status = max(status, 1)
        else:
            print("%s: ok (%d imports, none denied)" % (path, len(imports)))
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
