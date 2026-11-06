#!/usr/bin/env node
// Runs the Agent Market poll on a deployed app by hand, the same request Vercel Cron sends.
//
//   node scripts/market-poll.mjs --url https://<project>.vercel.app
//   node scripts/market-poll.mjs --url https://<project>.vercel.app --every 60
//
// Reads CRON_SECRET from the environment, else from web/.env.local. Prints the poll report: how many
// assignments were in progress, how many it started, and what it did with each (ids only).

import { join } from 'node:path';
import { CliError, log, parseCli, runMain, sleep } from './lib/cli.mjs';
import { REPO_ROOT } from './lib/deps.mjs';
import { readEnvFile } from './lib/envfile.mjs';

const args = parseCli({
  url: { type: 'string' },
  every: { type: 'string' },
  help: { type: 'boolean', default: false },
});

runMain(async () => {
  if (args.help || !args.url) {
    log('Usage: node scripts/market-poll.mjs --url https://<project>.vercel.app [--every <seconds>]');
    return args.help ? 0 : 2;
  }
  const origin = new URL(args.url).origin;
  const secret = process.env.CRON_SECRET || readEnvFile(join(REPO_ROOT, 'web', '.env.local')).CRON_SECRET;
  if (!secret) throw new CliError('CRON_SECRET is not set in the environment or web/.env.local', 2);
  const every = args.every ? Number(args.every) : 0;
  if (args.every && !(every >= 30)) throw new CliError('--every must be at least 30 seconds', 2);

  for (;;) {
    const started = new Date().toISOString();
    try {
      const res = await fetch(`${origin}/api/market/poll`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(310_000),
      });
      log(`${started}  HTTP ${res.status}`);
      log(JSON.stringify(await res.json().catch(() => null), null, 2));
      if (!every && !res.ok) return 1;
    } catch (error) {
      log(`${started}  request failed: ${error.message}`);
      if (!every) return 1;
    }
    if (!every) return 0;
    await sleep(every * 1000);
  }
});
