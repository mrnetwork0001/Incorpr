import type { Metadata } from 'next';
import { accountExplorerUrl, getNetworkConfig, type NetworkConfig } from '@/lib/near';
import { teeConfigured } from '@/lib/nearAiTee';
import { EncumbrancePill } from '../encumbrance-pill';
import { AppShell } from '../ui/app-shell';
import { Address, Glass, GlassHeader, KeyValue, Notice, PageHeader, TxHash } from '../ui';
import { CLAIMS, KEY_HOLDERS, hasAnyEvidenceSource, matchingTransactions, type Claim, type LiveCheckId } from './claims';
import { MAX_VAULTS, runLiveChecks, type CheckStatus, type LiveReport } from './checks';
import { AccountCell, CheckRow, Command, EvidenceItem, Section, StatusBadge } from './parts';
import { abiMethods, loadEvidence, repoWasm, sourceFacts, testIndex, type EvidenceLoad, type TestIndex } from './sources';
import { nearCodeHash, sha256Hex } from './wasm';
import v from './verify.module.css';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const metadata: Metadata = { title: 'Verify the claims | Incorpr' };

const EVIDENCE_PER_CLAIM = 4;
/** Names that would mean a public method can replace the vault's code or keys. */
const UPGRADE_NAMES = /upgrade|migrate|deploy|update_contract|add_key|full_access|delete_account|set_code/i;

function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash;
}

// ---------------------------------------------------------------------------- Live summaries per claim

function liveSummary(id: LiveCheckId, report: LiveReport): { status: CheckStatus; text: string } {
  const registry = report.registry;
  const network = report.config.network;
  if (id === 'protocol') {
    const own = report.node.value;
    const main = report.mainnetNode;
    if (!own) return { status: 'unavailable', text: `Could not read ${network} status: ${report.node.detail}` };
    const parts = [`${network} runs protocol ${own.protocol_version}`];
    if (main) parts.push(`mainnet runs protocol ${main.protocol_version}`);
    return { status: 'info', text: `${parts.join('; ')}. Read from the node status RPC on this page load.` };
  }
  if (!registry) return { status: 'unavailable', text: `No registry is configured for ${network}, so there are no vaults to check.` };
  if (registry.status !== 'pass') return { status: registry.status, text: registry.detail };
  const vaults = registry.vaults;
  if (vaults.length === 0) return { status: 'info', text: `${registry.registryId} has no companies yet.` };
  const count = (pick: (s: CheckStatus) => boolean, field: 'keys' | 'code' | 'addresses' | 'charter') =>
    vaults.filter((row) => pick(row[field].status)).length;
  const summarize = (field: 'keys' | 'code' | 'addresses' | 'charter', passText: string) => {
    const pass = count((s) => s === 'pass', field);
    const fail = count((s) => s === 'fail', field);
    const status: CheckStatus = fail > 0 ? 'fail' : pass === vaults.length ? 'pass' : pass > 0 ? 'info' : 'unavailable';
    return { status, text: `${pass} of ${vaults.length} vaults: ${passText}.${fail ? ` ${fail} failed.` : ''}` };
  };
  switch (id) {
    case 'vault-keys':
      return summarize('keys', 'view_access_key_list returned zero keys');
    case 'vault-code': {
      const base = summarize('code', 'code hash equals contracts/res/company_vault.wasm');
      return {
        status: base.status === 'pass' && registry.embedded.status !== 'pass' ? registry.embedded.status : base.status,
        text: `${base.text} Embedded in the registry's deployed code: ${registry.embedded.status === 'pass' ? 'yes' : registry.embedded.detail}.`,
      };
    }
    case 'vault-addresses':
      return summarize('addresses', 'stored addresses equal an off-chain derivation from the signer');
    case 'charter-hash':
      return summarize('charter', 'sha256 of the on-chain SVG equals media_hash');
  }
}

// ---------------------------------------------------------------------------- Sections

function LiveChecks({ report, evidence }: { report: LiveReport; evidence: EvidenceLoad }) {
  const { config, registry } = report;
  const mainnetExplorer: NetworkConfig = { ...config, explorers: { ...config.explorers, near: 'https://nearblocks.io' } };
  const repoVault = repoWasm('company_vault');
  const repoRegistry = repoWasm('incorpr_registry');
  const facts = sourceFacts();
  const vaultMethods = abiMethods('company_vault');
  const upgradeLike = vaultMethods?.filter((m) => UPGRADE_NAMES.test(m)) ?? [];
  const evidenceHash = evidence.kind === 'ok' ? (evidence.evidence.deployment.registry_code_hash ?? null) : null;
  const lastUpgrade = evidence.kind === 'ok' ? (evidence.evidence.deployment.registry_upgrades?.at(-1) ?? null) : null;

  return (
    <div className={v.stack}>
      <Glass lit>
        <GlassHeader title="Network" meta={<span className={v.mono}>checked {report.checkedAt}</span>} />
        <div className={v.checkList}>
          <CheckRow
            label={`NEAR ${config.network} RPC`}
            status={report.node.status}
            detail={
              report.node.value
                ? `${report.node.detail}, block ${report.node.value.sync_info.latest_block_height.toLocaleString('en-US')} via ${config.rpcUrl}`
                : report.node.detail
            }
          />
          {report.mainnetNode && (
            <CheckRow
              label="NEAR mainnet RPC (read only)"
              status="info"
              detail={`protocol ${report.mainnetNode.protocol_version}, block ${report.mainnetNode.sync_info.latest_block_height.toLocaleString('en-US')}`}
            />
          )}
        </div>
      </Glass>

      <Glass pad="none">
        <div className={v.tableWrap}>
          <table className={v.table}>
            <caption className="sr-only">External contracts the app calls, checked with view_account</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Account</th>
                <th scope="col">Network</th>
                <th scope="col">view_account</th>
                <th scope="col">Code hash</th>
              </tr>
            </thead>
            <tbody>
              {report.contracts.map((row) => {
                const href = row.accountId && !row.ownNetwork && row.network === 'mainnet' ? accountExplorerUrl(row.accountId, mainnetExplorer) : null;
                return (
                  <tr key={`${row.network}-${row.role}`}>
                    <td data-label="Role">{row.role}</td>
                    <td className={v.accountCol} data-label="Account">
                      <div className={v.cellStack}>
                        <AccountCell accountId={row.accountId} link={row.ownNetwork} />
                        {href && (
                          <a href={href} target="_blank" rel="noreferrer" className={v.muted}>
                            Open on NearBlocks
                          </a>
                        )}
                      </div>
                    </td>
                    <td className={v.mono} data-label="Network">{row.network}</td>
                    <td data-label="view_account">
                      <div className={v.cellStack}>
                        <StatusBadge status={row.status} />
                        <span className={v.muted}>{row.detail}</span>
                      </div>
                    </td>
                    <td className={v.mono} data-label="Code hash">{row.codeHash ? shortHash(row.codeHash) : '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Glass>

      {!registry ? (
        <Notice tone="info" title={`No registry configured for ${config.network}`}>
          <p>
            This app has no <code>NEXT_PUBLIC_REGISTRY_CONTRACT_ID</code>, so there are no vaults to read. After{' '}
            <code>node scripts/deploy.mjs --network {config.network}</code> writes it to <code>web/.env.local</code> and the app restarts, this
            section reads every vault&apos;s keys, code hash, addresses and charter from chain.
          </p>
        </Notice>
      ) : (
        <Glass lit>
          <GlassHeader
            title="Registry and vaults"
            meta={<Address value={registry.registryId} />}
          />
          <div className={v.checkList}>
            <CheckRow label="Registry contract deployed" status={registry.status} detail={registry.detail} />
            {registry.codeHash && (
              <>
                <CheckRow
                  label="Registry code hash equals contracts/res/incorpr_registry.wasm"
                  status={registry.repoMatch}
                  detail={`On chain ${registry.codeHash}${repoRegistry ? `, repo ${nearCodeHash(repoRegistry)}` : ', repo wasm not in this deployment'}`}
                />
                <CheckRow
                  label="Registry code hash equals the evidence log (deploy, or its latest upgrade)"
                  status={registry.evidenceMatch}
                  detail={
                    evidenceHash
                      ? `Evidence log: ${evidenceHash}${lastUpgrade ? `, upgraded in place from ${shortHash(lastUpgrade.from_code_hash)} by tx ${shortHash(lastUpgrade.tx_hash)}` : ''}`
                      : 'No deploy record in the evidence log'
                  }
                />
                <CheckRow
                  label="Full access keys on the registry account"
                  status="info"
                  detail={
                    registry.fullAccessKeys === null
                      ? 'Could not read the key list'
                      : `${registry.fullAccessKeys}. ${registry.fullAccessKeys > 0 ? 'Whoever holds it can redeploy registry code. Vault code and keys are not affected.' : 'The registry code cannot be replaced.'}`
                  }
                />
                <CheckRow label="Vault code is embedded in the registry's deployed code" status={registry.embedded.status} detail={registry.embedded.detail} />
              </>
            )}
          </div>
        </Glass>
      )}

      {registry && registry.vaults.length > 0 && (
        <div className={v.stack}>
          <div className={v.subRow}>
            <h3 className={v.sub}>
              Vaults ({registry.vaults.length}
              {registry.companies !== null && registry.companies > registry.vaults.length ? ` of ${registry.companies}` : ''})
            </h3>
            {registry.truncated && <p className={v.muted}>The first {MAX_VAULTS} companies are checked on each load.</p>}
          </div>
          <div className={v.vaultGrid}>
            {registry.vaults.map((row) => (
              <Glass key={row.vault} pad="md">
                <div className={v.vaultHead}>
                  <div className={v.vaultName}>
                    <span className={v.vaultTitle}>
                      #{row.tokenId} {row.name}
                    </span>
                    <Address value={row.vault} />
                  </div>
                  {row.encumbrance === 'FREE' || row.encumbrance === 'LISTED' || row.encumbrance === 'PLEDGED' ? (
                    <EncumbrancePill state={row.encumbrance} />
                  ) : (
                    <span className={v.mono}>{row.encumbrance}</span>
                  )}
                </div>
                <div className={v.checkList}>
                  <CheckRow label="Zero access keys" status={row.keys.status} detail={row.keys.detail} />
                  <CheckRow label="Code hash" status={row.code.status} detail={row.code.hash ? `${row.code.hash}. ${row.code.detail}` : row.code.detail} />
                  <CheckRow label="Treasury addresses" status={row.addresses.status} detail={row.addresses.detail}>
                    {(row.addresses.btc || row.addresses.evm || row.addresses.sol) && (
                      <span className={v.addressList}>
                        {row.addresses.btc && <Address value={row.addresses.btc} chain="btc" showChain />}
                        {row.addresses.evm && <Address value={row.addresses.evm} chain="evm" showChain />}
                        {row.addresses.sol && <Address value={row.addresses.sol} chain="sol" showChain />}
                      </span>
                    )}
                  </CheckRow>
                  <CheckRow label="Charter media_hash" status={row.charter.status} detail={row.charter.detail} />
                  <CheckRow
                    label="Raw signatures this epoch"
                    status={row.rawSigsThisEpoch === null ? 'unavailable' : row.rawSigsThisEpoch === 0 ? 'pass' : 'info'}
                    detail={row.rawSigsThisEpoch === null ? 'Could not read get_state' : `${row.rawSigsThisEpoch}. Above zero blocks listing and pledging.`}
                  />
                </div>
              </Glass>
            ))}
          </div>
        </div>
      )}

      <Glass>
        <GlassHeader title="Read from the contract source on this request" />
        {facts === null ? (
          <p className={v.muted}>The contract sources are not part of this deployment. Read them in the repository under contracts/.</p>
        ) : (
          <div className={v.facts}>
            {facts.map((fact) => (
              <div key={fact.label} className={v.fact}>
                <div className={v.checkLabel}>
                  <span>{fact.label}</span>
                  <span className={v.testWhere}>
                    {fact.file}
                    {fact.line ? `:${fact.line}` : ''}
                  </span>
                </div>
                <StatusBadge status={fact.ok ? 'pass' : 'fail'} />
                {fact.excerpt && <code className={v.excerpt}>{fact.excerpt}</code>}
              </div>
            ))}
            {vaultMethods && (
              <div className={v.fact}>
                <div className={v.checkLabel}>
                  <span>No public vault method upgrades code or manages keys</span>
                  <span className={v.checkDetail}>
                    contracts/res/company_vault_abi.json lists {vaultMethods.length} public methods
                    {upgradeLike.length ? `. Suspicious names: ${upgradeLike.join(', ')}` : '. None is named for an upgrade, a deploy or a key change.'}
                  </span>
                </div>
                <StatusBadge status={upgradeLike.length ? 'fail' : 'pass'} />
              </div>
            )}
            {repoVault && (
              <div className={v.fact}>
                <div className={v.checkLabel}>
                  <span>contracts/res/company_vault.wasm</span>
                  <span className={v.checkDetail}>
                    {repoVault.length.toLocaleString('en-US')} bytes, sha256 {sha256Hex(repoVault)}, NEAR code hash {nearCodeHash(repoVault)}
                  </span>
                </div>
                <StatusBadge status="info" />
              </div>
            )}
          </div>
        )}
      </Glass>
    </div>
  );
}

function ClaimCard({
  claim,
  n,
  tests,
  report,
  evidence,
}: {
  claim: Claim;
  n: number;
  tests: TestIndex;
  report: LiveReport;
  evidence: EvidenceLoad;
}) {
  const live = claim.live ? liveSummary(claim.live, report) : null;
  const txs = evidence.kind === 'ok' ? matchingTransactions(evidence.evidence, claim) : [];
  const ev = evidence.kind === 'ok' ? evidence.evidence : null;
  const teeCalls = ev && claim.evidence.teeCalls ? ev.tee_calls : [];
  const teeNodes = ev && claim.evidence.teeDeploy ? (ev.deployment.tee?.nodes ?? []) : [];
  const quotes = ev && claim.evidence.quotes ? ev.quotes : [];
  const bitcoin = ev && claim.evidence.bitcoin ? ev.bitcoin : [];
  const recorded = txs.length + teeCalls.length + teeNodes.length + quotes.length + bitcoin.length;

  return (
    <Glass as="article" pad="lg" style={{ animationDelay: `${Math.min(n, 8) * 40}ms` }}>
      <div className={v.claimHead}>
        <span className={v.claimNo}>{String(n).padStart(2, '0')}</span>
        <div>
          <p className={v.claimText}>{claim.claim}</p>
          <p className={v.claimSource}>Landing page: {claim.source}</p>
        </div>
      </div>
      <div className={v.claimGrid}>
        <div>
          <p className={v.colHead}>Contract method</p>
          {claim.methods.length ? (
            <div className={v.chips}>
              {claim.methods.map((m) => (
                <code key={m} className={v.code}>
                  {m}
                </code>
              ))}
            </div>
          ) : (
            <p className={v.muted}>Build property, not a method</p>
          )}
        </div>
        <div>
          <p className={v.colHead}>Proved by</p>
          <div className={v.testList}>
            {claim.tests.map((name) => {
              const at = tests.tests.get(name);
              return (
                <div key={name} className={v.test}>
                  <span className={`${v.testName} ${at || tests.missing.length ? '' : v.testMissing}`}>{name}</span>
                  <span className={v.testWhere}>
                    {at
                      ? `${at.kind === 'sandbox' ? 'sandbox' : 'unit'} test, ${at.file}:${at.line}`
                      : tests.missing.length
                        ? 'contract sources not in this deployment'
                        : 'not found in the contract sources'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <p className={v.colHead}>Live evidence</p>
          <div className={v.evidenceList}>
            {live && (
              <div className={v.evidenceItem}>
                <div className={v.evidenceTop}>
                  <StatusBadge status={live.status} label={live.status === 'pass' ? 'Live pass' : undefined} />
                  <span className={v.muted}>checked on this page load</span>
                </div>
                <p className={v.evidencePurpose}>{live.text}</p>
              </div>
            )}
            {txs.slice(0, EVIDENCE_PER_CLAIM).map((tx) => (
              <EvidenceItem key={`${tx.seq}-${tx.tx_hash}`} tx={tx} />
            ))}
            {txs.length > EVIDENCE_PER_CLAIM && (
              <p className={v.muted}>
                {txs.length - EVIDENCE_PER_CLAIM} more in {evidence.file}
              </p>
            )}
            {teeNodes.map((node) => {
              const checks = Object.entries(node.checks ?? {});
              const passed = checks.filter(([, value]) => value === true).length;
              return (
                <div key={node.signing_address} className={v.evidenceItem}>
                  <div className={v.evidenceTop}>
                    <code className={v.code}>tee_signers</code>
                    <span className={v.ok}>
                      {passed} of {checks.length} attestation checks passed at deploy
                    </span>
                  </div>
                  <Address value={node.signing_address} chain="evm" noLink />
                </div>
              );
            })}
            {teeCalls.slice(0, 2).map((call) => (
              <div key={call.chat_id} className={v.evidenceItem}>
                <div className={v.evidenceTop}>
                  <code className={v.code}>{call.model}</code>
                </div>
                <p className={v.evidencePurpose}>
                  TEE chat {call.chat_id}, call {shortHash(call.call_id)}
                  {call.signing_address ? `, signed by ${call.signing_address}` : ''}
                </p>
              </div>
            ))}
            {quotes.slice(0, 2).map((q, i) => (
              <div key={`${q.origin_asset}-${q.destination_asset}-${i}`} className={v.evidenceItem}>
                <div className={v.evidenceTop}>
                  <code className={v.code}>1Click dry quote</code>
                  {q.error ? <span className={v.rejected}>{q.error}</span> : <span className={v.ok}>quoted</span>}
                </div>
                <p className={v.evidencePurpose}>
                  {q.origin_asset} to {q.destination_asset}, {q.amount_in} in
                  {q.min_amount_out ? `, ${q.min_amount_out} min out` : ''}
                  {q.floor_min_buy ? ` against a floor of ${q.floor_min_buy}` : ''}
                </p>
              </div>
            ))}
            {bitcoin.slice(0, 2).map((b, i) =>
              typeof b.txid === 'string' ? <TxHash key={b.txid} value={b.txid} chain="btc" /> : <p key={i} className={v.muted}>Bitcoin entry recorded at {b.at ?? 'unknown time'}</p>,
            )}
            {recorded === 0 && hasAnyEvidenceSource(claim) && (
              <p className={v.muted}>
                {evidence.kind === 'ok' ? `No live evidence recorded yet. ${evidence.file} has no matching entry.` : 'No live evidence recorded yet.'}
              </p>
            )}
            {recorded === 0 && !hasAnyEvidenceSource(claim) && !live && (
              <p className={v.muted}>The demo script does not run this path on a live network. The tests above do, on a local sandbox.</p>
            )}
          </div>
        </div>
      </div>
      {claim.note && <p className={v.note}>{claim.note}</p>}
    </Glass>
  );
}

type Reality = { component: string; real: string; simulated: string; status: CheckStatus; statusText: string };

function realityRows(report: LiveReport, evidence: EvidenceLoad, tests: TestIndex): Reality[] {
  const { config } = report;
  const contract = (role: string) => report.contracts.find((c) => c.role === role && c.ownNetwork);
  const ev = evidence.kind === 'ok' ? evidence.evidence : null;
  const tee = teeConfigured();
  const signer = contract('Chain Signatures signer');
  const intents = contract('NEAR Intents verifier');
  return [
    {
      component: 'Contracts',
      real: 'incorpr-registry and company-vault, built to wasm by scripts/build-contracts.sh. The tests run the same wasm files.',
      simulated: `Tests run on a local nearcore sandbox. ${tests.sandbox} sandbox and ${tests.unit} unit tests are in the source.`,
      status: report.registry?.status === 'pass' ? 'pass' : 'info',
      statusText:
        report.registry?.status === 'pass'
          ? `Registry live on ${config.network}`
          : report.registry
            ? `Registry not readable on ${config.network}`
            : `Not deployed on ${config.network} yet`,
    },
    {
      component: 'Chain Signatures',
      real: `${config.mpcContract} derives keys and signs on ${config.network}.`,
      simulated: 'The sandbox tests use mpc_signer_double from contracts/test-doubles, because a sandbox cannot reach the MPC network.',
      status: signer?.status ?? 'unavailable',
      statusText: signer ? `${signer.accountId}: ${signer.detail}` : 'Not checked',
    },
    {
      component: 'USDC',
      real: 'Native USDC (Circle) on mainnet. Customers pay with ft_transfer_call.',
      simulated: 'Testnet uses Test USDC, which has no value. The sandbox uses test_usdc.',
      status: config.network === 'mainnet' ? 'pass' : 'info',
      statusText: config.usdcToken ? `${config.network}: ${config.usdcToken}` : `${config.network}: no USDC token configured`,
    },
    {
      component: 'NEAR Intents',
      real: 'intents.near settles on mainnet. 1Click quotes are real API calls.',
      simulated:
        'Sandbox tests use intents_double. Testnet has no intents deployment. One treasury swap settled on mainnet (docs/evidence/rebalance-mainnet.json). This hosted app only quotes rebalances unless INCORPR_ALLOW_MAINNET_REBALANCE is true.',
      status: intents?.status === 'pass' ? 'pass' : 'info',
      statusText: intents?.accountId ? `${intents.accountId}: ${intents.detail}` : (intents?.detail ?? 'Not configured'),
    },
    {
      component: 'NEAR AI Cloud',
      real: 'Inference runs on cloud-api.near.ai. The route checks the attestation and the response signature before it marks a call served.',
      simulated: 'Nothing. Without NEAR_AI_API_KEY the TEE routes answer HTTP 503 and the UI says so.',
      status: 'info',
      statusText: tee ? 'An API key is configured on this server. This page does not spend it on a test call.' : 'No API key on this server: TEE routes answer 503',
    },
    {
      component: 'Demo counterparties',
      real: 'Every sale, loan and payment in the evidence log is a real contract execution.',
      simulated: 'demo-buyer, demo-lender and demo-customer are controlled by the deployer, so they are not independent parties.',
      status: ev ? 'info' : 'unavailable',
      statusText: ev ? `${ev.transactions.length} transactions recorded in ${evidence.file}` : 'No live evidence recorded yet',
    },
    {
      component: 'Bitcoin spend',
      real: 'request_shareholder_signature returns a v1.signer signature over a BIP-143 sighash; scripts/demo.mjs broadcasts it to an Esplora node.',
      simulated:
        'One mainnet spend so far: 9,523 sats from the epoch 0 address, signed and held (listing was then refused), then broadcast and confirmed. No EVM or Solana spend has been broadcast.',
      status: ev && ev.bitcoin.length ? 'pass' : 'info',
      statusText: ev && ev.bitcoin.length ? `${ev.bitcoin.length} Bitcoin entries recorded` : 'No live Bitcoin spend recorded yet',
    },
    {
      component: 'L1 freshness check',
      real: '/api/verify-l1 reads BTC UTXOs and SOL/EVM nonces.',
      simulated:
        'Advisory. The desk runs it before List and Accept and blocks both when it is dirty, but the contract does not wait for it. The on-chain rule is ERR_RAW_SIGNATURES_THIS_EPOCH.',
      status: 'info',
      statusText: 'Desk gate, not a contract gate',
    },
  ];
}

/** 2026-11-06T15:25:12.400Z -> 2026-11-06 15:25 UTC; anything unparseable is shown as given. */
function utcMinute(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function EvidenceStatus({ evidence }: { evidence: EvidenceLoad }) {
  if (evidence.kind === 'absent') return <>No live evidence recorded yet ({evidence.file} does not exist)</>;
  if (evidence.kind === 'invalid') return <>Could not parse {evidence.file}: {evidence.message}</>;
  const e = evidence.evidence;
  return (
    <span className={v.mono}>
      {e.transactions.length} {e.transactions.length === 1 ? 'transaction' : 'transactions'}, {e.companies.length}{' '}
      {e.companies.length === 1 ? 'company' : 'companies'}
      {e.deployment.updated_at ? `, updated ${utcMinute(e.deployment.updated_at)}` : ''}
    </span>
  );
}

export default async function VerifyPage() {
  const config = getNetworkConfig();
  const evidence = loadEvidence(config.network);
  const tests = testIndex();
  const report = await runLiveChecks(
    { vaultWasm: repoWasm('company_vault'), registryWasm: repoWasm('incorpr_registry') },
    evidence.kind === 'ok' ? (evidence.evidence.deployment.registry_code_hash ?? null) : null,
  );
  const reality = realityRows(report, evidence, tests);

  return (
    <AppShell>
      <div className={v.page}>
        <PageHeader
          eyebrow="Verify"
          title="Every claim, next to"
          accent="the code that proves it."
          intro={
            <>
              Each claim from the landing page with the contract method that implements it, the test that proves it, and what this page read
              from chain on this request. Where a live network has not run a path yet, the page says so.
            </>
          }
          aside={
            <Glass className={v.headerFacts}>
              <KeyValue
                items={[
                  { label: 'Network', value: config.network, mono: true },
                  { label: 'Registry', value: config.registryId ? <Address value={config.registryId} /> : 'Not configured' },
                  { label: 'Signer', value: config.mpcContract, mono: true },
                  { label: 'Tests in source', value: tests.tests.size === 0 ? 'Sources not in this deployment' : `${tests.sandbox} sandbox, ${tests.unit} unit`, mono: true },
                  { label: 'Evidence', value: <EvidenceStatus evidence={evidence} /> },
                ]}
              />
            </Glass>
          }
        />

        <Section
          id="live"
          index="01"
          eyebrow="Live checks"
          title="Read from chain on this request."
          intro="JSON-RPC calls made while this page rendered: view_account, view_access_key_list and view_code on each account, plus the signer's derived keys for each vault."
        >
          <LiveChecks report={report} evidence={evidence} />
        </Section>

        <Section
          id="claims"
          index="02"
          eyebrow="Claims"
          title="What the landing page says, and how to check it."
          intro={
            <>
              Test names are looked up in the contract sources on each request. Live evidence comes from <code className={v.code}>{evidence.file}</code>,
              which only scripts/deploy.mjs and scripts/demo.mjs write. Each entry links to the transaction on the explorer.
            </>
          }
        >
          <div className={v.claims}>
            {CLAIMS.map((claim, i) => (
              <ClaimCard key={claim.id} claim={claim} n={i + 1} tests={tests} report={report} evidence={evidence} />
            ))}
          </div>
        </Section>

        <Section
          id="keys"
          index="03"
          eyebrow="Key holders"
          title="Who holds which key: can, and can never."
          intro="From docs/ARCHITECTURE.md section 1. Each can-never row is enforced in the vault or registry code and covered by the tests above. Where a holder's power rests on trust instead, the row says so."
        >
          <Glass pad="none">
            <div className={v.tableWrap}>
              <table className={v.table}>
                <thead>
                  <tr>
                    <th scope="col">Holder</th>
                    <th scope="col">Can</th>
                    <th scope="col">Can never</th>
                  </tr>
                </thead>
                <tbody>
                  {KEY_HOLDERS.map((row) => (
                    <tr key={row.holder}>
                      <td data-label="Holder">
                        <div className={v.cellStack}>
                          <span>{row.holder}</span>
                          <span className={v.testWhere}>{row.account}</span>
                        </div>
                      </td>
                      <td data-label="Can">
                        <ul className={`${v.list} ${v.canList}`}>
                          {row.can.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </td>
                      <td data-label="Can never">
                        <ul className={`${v.list} ${v.neverList}`}>
                          {row.never.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                        {row.trust && <p className={v.trust}>{row.trust}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Glass>
        </Section>

        <Section
          id="real"
          index="04"
          eyebrow="Scope"
          title="What is real, and what is simulated."
          intro="Test doubles exist only in the sandbox tests. The app never shows sample companies, balances or hashes."
        >
          <Glass pad="none">
            <div className={v.tableWrap}>
              <table className={v.table}>
                <thead>
                  <tr>
                    <th scope="col">Component</th>
                    <th scope="col">Real</th>
                    <th scope="col">Simulated or not yet run</th>
                    <th scope="col">On {config.network} now</th>
                  </tr>
                </thead>
                <tbody>
                  {reality.map((row) => (
                    <tr key={row.component}>
                      <td data-label="Component">{row.component}</td>
                      <td data-label="Real">{row.real}</td>
                      <td data-label="Simulated or not yet run">{row.simulated}</td>
                      <td data-label={`On ${config.network} now`}>
                        <div className={v.cellStack}>
                          <StatusBadge status={row.status} />
                          <span className={v.muted}>{row.statusText}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Glass>
        </Section>

        <Section id="run" index="05" eyebrow="Reproduce" title="Run the proofs yourself.">
          <div className={v.commands}>
            <Command
              command="cd contracts && cargo test --workspace"
              what="Unit tests plus the sandbox suite on a local nearcore 2.14.0 node at protocol 87. The last recorded run: 78 passed."
            />
            <Command
              command="node scripts/deploy.mjs --network mainnet --dry-run"
              what="Prices a mainnet deploy with read-only RPC, a live TEE attestation and live 1Click prices. Sends nothing."
            />
            <Command
              command="node scripts/lib/sandbox.mjs start --fresh && node scripts/deploy.mjs --network sandbox && node scripts/demo.mjs --network sandbox --all --skip serve"
              what="The whole lifecycle on a local sandbox, including the refused rug attempts with their error codes."
            />
          </div>
        </Section>
      </div>
    </AppShell>
  );
}
