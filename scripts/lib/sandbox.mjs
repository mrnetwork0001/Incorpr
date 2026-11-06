// Local nearcore sandbox for rehearsing deploy.mjs and demo.mjs without spending anything.
//
// The node is the nearcore release the integration tests use (contracts/integration-tests/tests/
// sandbox.rs: 2.14.0). Genesis is pinned to protocol 87 like the tests, or to
// INCORPR_SANDBOX_PROTOCOL. The node runs detached, so deploy.mjs and demo.mjs can be separate
// processes.
//
//   node scripts/lib/sandbox.mjs start [--fresh] [--port 32123]
//   node scripts/lib/sandbox.mjs status
//   node scripts/lib/sandbox.mjs stop [--reset]

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, parseCli, runMain, sleep } from './cli.mjs';
import { REPO_ROOT } from './deps.mjs';

export const SANDBOX_NEARCORE = '2.14.0';
/** Override with INCORPR_SANDBOX_PROTOCOL (mainnet moved to 88 on 2026-11-06; 2.14.0 runs 88 by default). */
export const SANDBOX_PROTOCOL = Number(process.env.INCORPR_SANDBOX_PROTOCOL || 87);
export const SANDBOX_ROOT = 'test.near';
const DEFAULT_PORT = 32123;

export function sandboxHome() {
  return process.env.INCORPR_SANDBOX_HOME || join(tmpdir(), 'incorpr-sandbox');
}

const statePath = (home) => join(home, 'sandbox.json');
export const sandboxCredentialsDir = (home = sandboxHome()) => join(home, 'credentials');

/** The binary near-sandbox (the Rust crate) downloaded for the integration tests, or NEAR_SANDBOX_BIN. */
export function findSandboxBinary() {
  if (process.env.NEAR_SANDBOX_BIN) return process.env.NEAR_SANDBOX_BIN;
  const candidates = [];
  for (const profile of ['debug', 'release']) {
    const build = join(REPO_ROOT, 'contracts', 'target', profile, 'build');
    if (!existsSync(build)) continue;
    for (const dir of readdirSync(build)) {
      if (!dir.startsWith('near-sandbox-')) continue;
      candidates.push(join(build, dir, 'out', '.near', `near-sandbox-${SANDBOX_NEARCORE}`, 'near-sandbox'));
    }
  }
  candidates.push(join(process.env.HOME ?? '', '.near', `near-sandbox-${SANDBOX_NEARCORE}`, 'near-sandbox'));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new CliError(
      `near-sandbox ${SANDBOX_NEARCORE} not found. Run "cd contracts && cargo test --workspace" once (it downloads it), or set NEAR_SANDBOX_BIN.`,
    );
  }
  return found;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rpcStatus(rpcUrl) {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] }),
      signal: AbortSignal.timeout(3_000),
    });
    return (await res.json()).result ?? null;
  } catch {
    return null;
  }
}

export function readSandboxState(home = sandboxHome()) {
  return existsSync(statePath(home)) ? JSON.parse(readFileSync(statePath(home), 'utf8')) : null;
}

/** The running sandbox, or null. */
export async function runningSandbox(home = sandboxHome()) {
  const state = readSandboxState(home);
  if (!state || !alive(state.pid)) return null;
  const status = await rpcStatus(state.rpc_url);
  return status ? { ...state, status } : null;
}

export async function startSandbox({ fresh = false, port = DEFAULT_PORT, home = sandboxHome() } = {}) {
  const running = await runningSandbox(home);
  if (running && !fresh) return running;
  if (running) stopSandbox({ home });

  const nodeHome = join(home, 'node');
  const binary = findSandboxBinary();
  if (fresh || !existsSync(join(nodeHome, 'genesis.json'))) {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const init = spawnSync(binary, ['--home', nodeHome, 'init', '--fast'], { encoding: 'utf8' });
    if (init.status !== 0) throw new CliError(`near-sandbox init failed: ${init.stderr || init.stdout}`);

    // Pin the runtime to mainnet's protocol, as the integration tests do.
    const genesisPath = join(nodeHome, 'genesis.json');
    const genesis = JSON.parse(readFileSync(genesisPath, 'utf8'));
    genesis.protocol_version = SANDBOX_PROTOCOL;
    writeFileSync(genesisPath, JSON.stringify(genesis));
    const configPath = join(nodeHome, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.rpc = { ...config.rpc, limits_config: { ...(config.rpc?.limits_config ?? {}), json_payload_max_size: 1024 * 1024 * 1024 } };
    config.store = { ...config.store, max_open_files: 3000 };
    writeFileSync(configPath, JSON.stringify(config));

    const validator = JSON.parse(readFileSync(join(nodeHome, 'validator_key.json'), 'utf8'));
    mkdirSync(sandboxCredentialsDir(home), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(sandboxCredentialsDir(home), `${validator.account_id}.json`),
      JSON.stringify({ account_id: validator.account_id, public_key: validator.public_key, private_key: validator.secret_key }),
      { mode: 0o600 },
    );
  }

  const logFd = openSync(join(home, 'node.log'), 'a');
  const child = spawn(
    binary,
    ['--home', nodeHome, 'run', '--rpc-addr', `127.0.0.1:${port}`, '--network-addr', `127.0.0.1:${port + 1}`],
    { detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  let status = null;
  while (Date.now() < deadline) {
    await sleep(1_000);
    if (!alive(child.pid)) throw new CliError(`near-sandbox exited during start. See ${join(home, 'node.log')}`);
    status = await rpcStatus(rpcUrl);
    if (status && status.sync_info.latest_block_height > 2) break;
  }
  if (!status) throw new CliError(`near-sandbox did not answer on ${rpcUrl}. See ${join(home, 'node.log')}`);
  if (status.protocol_version !== SANDBOX_PROTOCOL) {
    throw new CliError(`sandbox runs protocol ${status.protocol_version}, want ${SANDBOX_PROTOCOL}`);
  }
  const state = {
    pid: child.pid,
    rpc_url: rpcUrl,
    home,
    node_home: nodeHome,
    binary,
    nearcore: SANDBOX_NEARCORE,
    protocol_version: status.protocol_version,
    root_account: SANDBOX_ROOT,
    started_at: new Date().toISOString(),
  };
  writeFileSync(statePath(home), `${JSON.stringify(state, null, 2)}\n`);
  return { ...state, status };
}

export function stopSandbox({ home = sandboxHome(), reset = false } = {}) {
  const state = readSandboxState(home);
  if (state && alive(state.pid)) {
    process.kill(state.pid, 'SIGTERM');
    // Wait up to 15 s for a clean exit, then force it.
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 150 && alive(state.pid); i += 1) Atomics.wait(pause, 0, 0, 100);
    if (alive(state.pid)) process.kill(state.pid, 'SIGKILL');
  }
  if (existsSync(statePath(home))) rmSync(statePath(home));
  if (reset) rmSync(home, { recursive: true, force: true });
  return state;
}

async function main() {
  const command = process.argv[2];
  const args = parseCli(
    { fresh: { type: 'boolean', default: false }, reset: { type: 'boolean', default: false }, port: { type: 'string' } },
    process.argv.slice(3),
  );
  if (command === 'start') {
    const state = await startSandbox({ fresh: args.fresh, port: args.port ? Number(args.port) : DEFAULT_PORT });
    console.log(`sandbox running: ${state.rpc_url} (nearcore ${state.nearcore}, protocol ${state.status.protocol_version}, pid ${state.pid})`);
    console.log(`home ${state.home}`);
    return 0;
  }
  if (command === 'status') {
    const state = await runningSandbox();
    if (!state) {
      console.log(`no sandbox running (home ${sandboxHome()})`);
      return 1;
    }
    console.log(`sandbox running: ${state.rpc_url}, protocol ${state.status.protocol_version}, height ${state.status.sync_info.latest_block_height}, pid ${state.pid}`);
    return 0;
  }
  if (command === 'stop') {
    const state = stopSandbox({ reset: args.reset });
    console.log(state ? `stopped pid ${state.pid}${args.reset ? ' and removed its home' : ''}` : 'no sandbox state found');
    return 0;
  }
  throw new CliError('usage: node scripts/lib/sandbox.mjs start [--fresh] [--port N] | status | stop [--reset]', 2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runMain(main);
