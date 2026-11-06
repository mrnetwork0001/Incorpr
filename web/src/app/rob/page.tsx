import type { Metadata } from 'next';
import { robShareMetadata } from '@/lib/og/metadata';
import { GUARDED_METHODS, type RobTargetView } from '@/lib/rob/attacks';
import { evidenceAttempts, targetView } from '@/lib/rob/server';
import { recentAttempts } from '@/lib/rob/store';
import { Address, EncumbrancePill, Glass, GlassHeader, KeyValue, Notice, PageHeader, Tabs } from '../ui';
import { AppShell } from '../ui/app-shell';
import { RobConsole } from './rob-console';
import s from './rob.module.css';

export const dynamic = 'force-dynamic';

export function generateMetadata({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }): Metadata {
  return {
    title: 'Rob this company | Incorpr',
    description:
      "Talk a company's treasury agent into sending you money, then watch NEAR refuse every transaction that tries. Each refusal links to its failed receipt.",
    // /rob?tx=<hash> shares the card of that refused transaction; otherwise the generic /rob card applies.
    ...robShareMetadata(searchParams.tx),
  };
}

function TargetSummary({ target }: { target: RobTargetView }) {
  const company = target.company;
  if (!company) return null;
  return (
    <Glass pad="sm" className={s.target} aria-label="House company">
      <KeyValue
        items={[
          { label: 'Company', value: `${company.name} #${target.tokenId}` },
          { label: 'State', value: <EncumbrancePill state={company.encumbrance} /> },
          { label: 'Vault', value: <Address value={company.vault} /> },
          { label: 'Agent operator', value: <Address value={company.operator} /> },
          ...(target.robAccount ? [{ label: 'Stranger', value: <Address value={target.robAccount} /> }] : []),
        ]}
      />
    </Glass>
  );
}

function SafetyPanel() {
  return (
    <Glass pad="lg" as="section" aria-labelledby="why-safe">
      <GlassHeader title={<span id="why-safe">Why it is safe</span>} meta="contracts/company-vault/src/lib.rs, in execution order" />
      <p className={s.lead}>
        A transaction stops at the first check it fails, and the vault panics with that check&apos;s error code. Nothing in the
        agent&apos;s reply reaches these checks: the vault reads only the caller, its own state and the signed proof.
      </p>
      <Tabs
        label="Guarded vault methods"
        tabs={GUARDED_METHODS.map((g) => ({
          id: g.method,
          label: <span className={s.tabLabel}>{g.method}</span>,
          badge: g.checks.length,
          content: (
            <ol className={s.checks}>
              {g.checks.map((check, i) => (
                <li key={`${g.method}-${i}`} className={s.checkRow}>
                  <span className={s.checkNum}>{String(i + 1).padStart(2, '0')}</span>
                  <span className={s.checkWhat}>{check.what}</span>
                  <span className={s.checkCodes}>
                    {check.codes.map((code) => (
                      <code key={code} className={s.codeChip}>
                        {code}
                      </code>
                    ))}
                  </span>
                </li>
              ))}
            </ol>
          ),
        }))}
      />
    </Glass>
  );
}

export default async function RobPage() {
  const target = await targetView();
  return (
    <AppShell>
      <PageHeader
        eyebrow="Rob this company"
        title="The agent can be talked into it."
        accent="The vault cannot."
        intro={
          <>
            {target.attemptsProblem ? (
              <p>
                Chat with the house company&apos;s treasury agent and try to talk it into sending you money. Sending attempts is off on
                this server (see below), so no transaction is sent from this page. Recorded refusals, where there are any, are listed
                under Recent attempts with their failed receipts.
              </p>
            ) : (
              <p>
                Chat with the house company&apos;s treasury agent and try to talk it into sending you money. Then press the button: this
                server sends real NEAR transactions that try to move the company&apos;s funds, from the agent&apos;s operator key and from a
                stranger&apos;s account. The vault contract refuses each one, and each refusal links to its failed receipt.
              </p>
            )}
            <p className={s.introNote}>No wallet needed. The server pays the gas, within a per-address and a daily limit.</p>
          </>
        }
        aside={<TargetSummary target={target} />}
      />

      {target.problem && (
        <Notice tone={target.registryId ? 'error' : 'info'} title="There is no company to rob on this server" className={s.notice}>
          <p>{target.problem}</p>
          <p>
            Deploy with <code>node scripts/deploy.mjs</code>, create the stranger account with <code>node scripts/rob-setup.mjs</code>, then
            restart the web server.
          </p>
        </Notice>
      )}

      <RobConsole target={target} initialAttempts={recentAttempts()} initialEvidence={evidenceAttempts()} safety={<SafetyPanel />} />
    </AppShell>
  );
}
