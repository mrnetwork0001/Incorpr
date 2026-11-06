// Argument checks in scripts/operator-key.mjs that run before any key file or RPC is touched. No
// network: every case here exits before the script reads chain state.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(__dirname, '../..');

function run(args: string[]): { status: number | null; output: string } {
  const out = spawnSync('node', ['scripts/operator-key.mjs', ...args], {
    cwd: REPO,
    // An RPC that cannot answer: a case that reached the network would fail with a different message.
    env: { ...process.env, INCORPR_SANDBOX_HOME: path.join(REPO, 'does-not-exist') },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { status: out.status, output: `${out.stdout}${out.stderr}` };
}

describe('operator-key.mjs argument checks', () => {
  it('refuses a mainnet run without --dry-run or --confirm-mainnet', () => {
    const { status, output } = run(['--network', 'mainnet']);
    expect(status).toBe(2);
    expect(output).toContain('Run with --dry-run first, then add --confirm-mainnet');
  });

  it('refuses a zero allowance, which would leave the gas uncapped', () => {
    const { status, output } = run(['--network', 'mainnet', '--dry-run', '--allowance', '0']);
    expect(status).toBe(2);
    expect(output).toContain('--allowance must be above 0');
  });

  it('refuses a payable method, since a function-call key cannot attach a deposit', () => {
    const { status, output } = run(['--network', 'mainnet', '--dry-run', '--methods', 'record_service_call,claim_dividends']);
    expect(status).toBe(2);
    expect(output).toContain('claim_dividends is payable');
  });

  it('refuses a method the compiled vault does not have', () => {
    const { status, output } = run(['--network', 'mainnet', '--dry-run', '--methods', 'drain']);
    expect(status).toBe(2);
    expect(output).toContain('company-vault has no method drain');
  });

  it('refuses a view method and a duplicate', () => {
    expect(run(['--network', 'mainnet', '--dry-run', '--methods', 'get_state']).output).toContain('get_state is a view');
    expect(run(['--network', 'mainnet', '--dry-run', '--methods', 'agent_swap_intent,agent_swap_intent']).output).toContain('lists a method twice');
  });

  it('refuses a receiver that is not a company vault of the registry', () => {
    for (const vault of ['intents.near', 'c-1.other.near', 'usdc.incorpr.near', 'c-1.x.incorpr.near']) {
      const { status, output } = run(['--network', 'mainnet', '--dry-run', '--vault', vault]);
      expect(status).toBe(2);
      expect(output).toContain('--vault must be a company vault of incorpr.near');
    }
  });

  it('needs a running sandbox for a sandbox run', () => {
    const { status, output } = run(['--network', 'sandbox', '--dry-run']);
    expect(status).toBe(1);
    expect(output).toContain('no sandbox running');
  });
});
