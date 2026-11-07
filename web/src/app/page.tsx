import Link from 'next/link';
import type { ReactNode } from 'react';
import type { TreasuryAddresses } from '@/lib/contracts';
import { deriveTreasuryAddresses } from '@/lib/mpcAddresses';
import { getNetworkConfig } from '@/lib/near';
import { EncumbrancePill } from './encumbrance-pill';
import { Hero, HeroNav } from './hero/hero';
import { LandingMotion } from './landing/landing-motion';
import ui from './landing/landing.module.css';
import { SiteFooter } from './ui/site-footer';

// The hero addresses are read from the MPC contract at render, then reused for an hour.
export const revalidate = 3600;

const EXAMPLE_REGISTRY = 'incorpr.testnet';
const SIGNER_TIMEOUT_MS = 8000;

async function readExampleAddresses(vaultAccount: string): Promise<TreasuryAddresses | null> {
  const { mpcContract, btcHrp } = getNetworkConfig();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), SIGNER_TIMEOUT_MS));
  const read = deriveTreasuryAddresses({ mpcContract, vaultAccount, tokenId: '1', epoch: 0, btcHrp }).catch(() => null);
  return Promise.race([read, timeout]);
}

const COMPARISON = [
  ['Who holds the key', 'Whoever generated it, indefinitely', 'Nobody. MPC nodes sign when the vault contract asks'],
  ['Seller access after the sale', 'Cannot be ruled out', 'Ends when the vault records the new shareholder'],
  ['Signatures issued before the sale', 'Invisible to the buyer', 'Counted on-chain. A company with any this epoch cannot be listed'],
  ['Revenue figures', 'Seller-supplied', 'Booked from USDC transfers. No account can report revenue'],
  ['Financing', 'Off-chain, or none', 'USDC loans against the NFT, with signing frozen until repayment'],
];

const LIFECYCLE: { step: string; title: string; method: string; body: string }[] = [
  {
    step: '01',
    title: 'Incorporate',
    method: 'incorporate_company',
    body: 'Creates c-<id>.<registry>, deploys the vault with no access keys, and mints the NFT only if that succeeds. A failed deployment refunds the deposit. The founder sets the per-call price, a treasury target across BTC, SOL and USDC, a royalty of up to 10%, and a compute reserve of at least 1%.',
  },
  {
    step: '02',
    title: 'Earn',
    method: 'ft_on_transfer',
    body: 'Customers pay per call in USDC on NEAR with ft_transfer_call. The vault checks the amount against the price, splits it between compute reserve and retained earnings, and stores the payment. Paying a call does not depend on the operator, and the service route checks the on-chain payment before it runs inference.',
  },
  {
    step: '03',
    title: 'Compound',
    method: 'agent_swap_intent',
    body: 'The treasury agent proposes a swap as structured fields. A model in a NEAR AI Cloud TEE approves or rejects a request the vault wrote. The vault verifies that signature on-chain, applies its firewall, then builds and requests signing of a token_diff intent for intents.near. This path is tested on a sandbox; execution on intents.near is not in this release.',
  },
  {
    step: '04',
    title: 'Finance',
    method: 'accept_offer',
    body: 'Lenders post funded USDC offers against a specific company. When the owner accepts, the vault freezes first and the principal is sent second. Repayment unfreezes it. After a default, a Dutch auction runs from 200% down to 50% of the debt. With no bid, the lender can claim the company.',
  },
  {
    step: '05',
    title: 'Sell',
    method: 'list_company',
    body: 'The owner lists at an ask in USDC. The listing activates only after the vault accepts the freeze. On purchase, shareholder rights are suspended, the NFT and funds move, the founder royalty is paid, and only then does the buyer become shareholder. If the vault step fails, the buyer is refunded.',
  },
];

const YES = 'Allowed';
const NO = 'Frozen';
const STATE_MATRIX: [string, string, string, string][] = [
  ['Raw L1 signing by shareholder', YES, NO, NO],
  ['Dividend claims', YES, NO, NO],
  ['Policy and operator changes', YES, NO, NO],
  ['Agent swaps and deposits', YES, NO, NO],
  ['Direct NFT transfer', YES, NO, NO],
  ['Receiving customer payments', YES, YES, YES],
  ['Serving paid calls, paying compute', YES, 'Charter operator', 'Charter operator'],
];

const PRE_SIGNED_RULE = [
  'Every raw signature increments raw_sigs_this_epoch before the MPC call is made.',
  'Listing or pledging panics while that counter is above zero, with ERR_RAW_SIGNATURES_THIS_EPOCH.',
  'rotate_treasury_epoch moves the company to new addresses and resets the counter. The seller moves funds across first.',
  "NAV counts only current-epoch addresses and the vault's intents.near balance, so counted assets sit on keys that have never signed a raw payload.",
];

const FIREWALL: [string, string][] = [
  ['Caller is the operator; company is FREE', 'ERR_ACCOUNT_ENCUMBERED_AGENT_FROZEN'],
  ["Tokens are on the shareholder's allow list", 'ERR_FIREWALL_BLOCKED_TOKEN'],
  ["Withdrawal destination is the company's own address", 'ERR_FIREWALL_BLOCKED_UNWHITELISTED_DESTINATION'],
  ['Per-token spend is inside the 24-hour cap', 'ERR_FIREWALL_EPOCH_CAP_EXCEEDED'],
  ["Swap rate meets the shareholder's price floor", 'ERR_FIREWALL_PRICE_BELOW_FLOOR'],
  ['Nonce has not been used', 'ERR_NONCE_USED'],
  ['Attested model signed exactly APPROVE <hash>', 'ERR_TEE_NOT_APPROVED'],
  ['Recovered signer is a trusted TEE key', 'ERR_TEE_SIGNATURE_UNTRUSTED'],
];

const ACTORS: [string, string, string][] = [
  [
    'Shareholder',
    'Claim dividends and sign raw L1 payloads while FREE. Rotate the treasury epoch.',
    'Sign, claim or change policy while listed, pledged or in transit.',
  ],
  [
    'Operator',
    'Request vault-built intents inside policy, with a TEE approval. Pay compute to a fixed payee. Mark paid calls as served.',
    'Supply bytes to sign, write the model prompt, choose a destination, or report revenue.',
  ],
  ['Registry', "Update the vault's owner and encumbrance.", "Sign anything on the vault's behalf."],
  ['Anyone', 'Trigger key setup, refresh metrics, read all state.', 'Choose which key is registered. The vault reads it from the signer.'],
];

const LIMITS = [
  'A compromised operator can resubmit a proposal until a nondeterministic model approves it, and a colluding solver can then fill at the minimum price. Loss per window is bounded by the epoch cap and price floor.',
  'A price floor is a shareholder-set lower bound, not an oracle. It goes stale when the market moves.',
  "30-day revenue is not sybil-resistant. Only the current shareholder's own payments are excluded, so a seller's second account counts as a customer. Payer concentration is readable through payment_stats.",
  'TEE signers, models and the prompt hash are set by the shareholder. A buyer should compare them with the live attestation. None of them widen the set of allowed destinations.',
  'While a company is listed, the charter operator can still spend the compute reserve, only to the fixed compute payee.',
];

const PRIMITIVES: [string, string, string][] = [
  ['NEAR sub-accounts', 'c-<id>.<registry>', 'One contract per company, isolated state, zero access keys, no upgrade method.'],
  [
    'Chain Signatures',
    'v1.signer',
    'Secp256k1 for Bitcoin and EVM, Ed25519 for Solana and intents. The vault composes every derivation path.',
  ],
  ['NEAR Intents', 'intents.near, 1Click', 'Treasury swaps signed under a key only the vault can use, priced against live 1Click quotes. One swap settled on mainnet: 0.5 USDC to SOL.'],
  [
    'NEAR AI Cloud',
    'cloud-api.near.ai',
    'Inference in Intel TDX and NVIDIA TEEs. The vault recovers the ECDSA signer with ecrecover before it acts on an approval.',
  ],
];

type StatusLevel = 'done' | 'partial' | 'pending';

// Update these rows as work lands. They are claims about the repo, so keep them true.
const STATUS: [string, string, StatusLevel][] = [
  ['Contract suite', '100 tests passing, 77 of them on a local NEAR sandbox node at protocol 87', 'done'],
  ['Web suite', '419 tests passing, 3 skipped, including end-to-end contract actions on a local sandbox', 'done'],
  ['Mainnet deployment', 'incorpr.near and the keyless vault c-1.incorpr.near at protocol 88. Pay, list, sell, lend, borrow, repay, claim dividends and a treasury swap all run on mainnet; 48 transactions re-checked against the chain', 'done'],
  ['Rob this company', 'Live on mainnet. Five attacks sent from real keys, including the agent agreeing in chat, and the vault refused each one on-chain', 'done'],
  ['TEE inference end to end', 'A paid call served by NEAR AI Cloud on mainnet; the ECDSA signature recovers to the attested TDX signer and the call is recorded on the vault', 'done'],
  ['Address derivation', 'Read from the live mainnet signer, v1.signer, on this page', 'done'],
  ['App screens', 'Exchange, Incorporate, Company, Desk, Rob and Verify, all reading mainnet state', 'done'],
  ['Treasury rebalance', 'Run on mainnet: TEE approval checked on-chain, intent signed by v1.signer for the vault, settled by a NEAR Intents solver. 0.5 USDC swapped to 0.005545636 SOL', 'done'],
  ['Transfer races', '13 sandbox tests send a payout and a sale, pledge or transfer in the same blocks, including a dividend claim still in flight when the company is sold. In each, the seller ends with at most the dividends accrued before the sale', 'done'],
  ['Threat model', 'docs/THREAT_MODEL.md lists 17 ways a seller or borrower could try to keep the money, each with the contract rule, its test and the mainnet transaction where one exists', 'done'],
  ['Per-company history', 'The company page lists payments, payouts, refusals and every holder, rebuilt from contract events and reconciled with the vault counters on 8 fields', 'done'],
  ['Holder-only owner room', '/company/1/owner opens only for the account nft_token names, checked on every request. Tested with real NEP-413 signatures and a mocked chain; a wallet sign-in by the mainnet holder has not been run', 'partial'],
  ['Scoped operator key', 'Live on mainnet: the server signs with a function-call key limited to the vault and five methods. The chain refused a transfer, another contract, a deposit and an unlisted method signed with it', 'done'],
  ['Bitcoin spend and held signature', 'Run on mainnet: the owner had the vault sign a BTC transfer and held it; listing was refused with ERR_RAW_SIGNATURES_THIS_EPOCH. The transfer was then broadcast from the keyless address and the epoch rotated', 'done'],
  ['Pay in another token', 'Run on mainnet: wNEAR swapped to USDC through NEAR Intents 1Click, then booked by the vault as a paid call. A source token on another chain takes the same 1Click route; not run', 'done'],
];

const STATUS_STYLES: Record<StatusLevel, { label: string; className: string | undefined }> = {
  done: { label: 'Done', className: ui.done },
  partial: { label: 'Partial', className: ui.inProgress },
  pending: { label: 'Pending', className: ui.pending },
};

function Section({
  id,
  index,
  label,
  title,
  intro,
  children,
}: {
  id: string;
  index: string;
  label: string;
  title: string;
  intro?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className={ui.section}>
      <div className={ui.reveal}>
        <p className={ui.eyebrow}>
          <span className={ui.eyebrowIndex}>{index}</span>
          {label}
        </p>
        <h2 className={ui.title}>{title}</h2>
        {intro && <p className={ui.intro}>{intro}</p>}
      </div>
      <div className={ui.body}>{children}</div>
    </section>
  );
}

function GlassTable({ head, rows, litCol }: { head: string[]; rows: string[][]; litCol?: number }) {
  const lit = (i: number) => (i === litCol ? ui.litCol : undefined);
  return (
    <div className={`${ui.glass} ${ui.tableWrap} ${ui.reveal}`}>
      <table className={ui.table}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h || i} scope="col" className={lit(i)}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell, i) => (
                <td key={`${row[0]}-${i}`} className={lit(i)}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StateCell({ value }: { value: string }) {
  const className = value === YES ? ui.allowed : value === NO ? ui.frozen : ui.partial;
  return <span className={className}>{value}</span>;
}

const ICONS: Record<string, ReactNode> = {
  'NEAR sub-accounts': (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="2.5" y="2.5" width="15" height="15" rx="3.5" />
      <rect x="6.5" y="6.5" width="7" height="7" rx="1.8" />
    </svg>
  ),
  'Chain Signatures': (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <circle cx="6.5" cy="10" r="3.5" />
      <path d="M10 10h7.5M14.5 10v3M17 10v2" />
    </svg>
  ),
  'NEAR Intents': (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7h12l-3-3M17 13H5l3 3" />
    </svg>
  ),
  'NEAR AI Cloud': (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <rect x="5" y="5" width="10" height="10" rx="2" />
      <path d="M8 2.5v2.5M12 2.5v2.5M8 15v2.5M12 15v2.5M2.5 8h2.5M2.5 12h2.5M15 8h2.5M15 12h2.5" />
    </svg>
  ),
};


export default async function LandingPage() {
  const { mpcContract, registryId } = getNetworkConfig();
  const vaultAccount = `c-1.${registryId ?? EXAMPLE_REGISTRY}`;
  const addresses = await readExampleAddresses(vaultAccount);

  return (
    <>
      <HeroNav />

      <main>
        <Hero vaultAccount={vaultAccount} registryId={registryId} addresses={addresses} mpcContract={mpcContract} />

        <div className={ui.page}>
          <LandingMotion />
          <Section
            id="problem"
            index="01"
            label="The problem"
            title="An operating wallet cannot be safely sold."
            intro="Whoever generated a private key still has it after the sale, and a buyer cannot prove otherwise. That is why revenue-generating on-chain accounts are hard to sell or lend against."
          >
            <GlassTable head={['', 'Selling a wallet', 'Selling an Incorpr company']} rows={COMPARISON} litCol={2} />
          </Section>

          <Section
            id="how-it-works"
            index="02"
            label="How it works"
            title="From incorporation to exit."
            intro="Five stages, each a contract call you can read. The registry holds the NFT and the market. Each company's vault holds its money and signing rights."
          >
            <ol className={ui.timeline}>
              {LIFECYCLE.map((item) => (
                <li key={item.step} className={`${ui.glass} ${ui.step} ${ui.reveal}`}>
                  <div className={ui.stepHead}>
                    <span className={ui.stepNo}>{item.step}</span>
                    <h3 className={ui.stepTitle}>{item.title}</h3>
                    <code className={ui.code}>{item.method}</code>
                  </div>
                  <p className={ui.stepBody}>{item.body}</p>
                </li>
              ))}
            </ol>
          </Section>

          <Section
            id="states"
            index="03"
            label="Company state"
            title="Three states decide who can do what."
            intro="Listing or pledging freezes the owner's rights. The company keeps taking payments and serving calls, so it keeps earning while it is for sale or in debt."
          >
            <div className={`${ui.glass} ${ui.tableWrap} ${ui.reveal}`}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">
                      <EncumbrancePill state="FREE" />
                    </th>
                    <th scope="col">
                      <EncumbrancePill state="LISTED" />
                    </th>
                    <th scope="col">
                      <EncumbrancePill state="PLEDGED" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {STATE_MATRIX.map(([action, ...cells]) => (
                    <tr key={action}>
                      <td>{action}</td>
                      {cells.map((cell, i) => (
                        <td key={`${action}-${i}`}>
                          <StateCell value={cell} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            id="security"
            index="04"
            label="Security model"
            title="A freeze alone does not protect a buyer."
            intro="A seller can get a transaction signed, keep it unbroadcast, sell the company, then broadcast it. Freezing signing at listing does not stop that, and neither does a mempool check. Incorpr closes it by tracking what each key has signed."
          >
            <div className={ui.twoUp}>
              <div className={`${ui.glass} ${ui.glassLit} ${ui.card} ${ui.reveal}`}>
                <h3 className={ui.subhead}>Pre-signed transaction rule</h3>
                <ol className={ui.rules}>
                  {PRE_SIGNED_RULE.map((rule, i) => (
                    <li key={rule} className={ui.rule}>
                      <span className={ui.ruleNo}>{String(i + 1).padStart(2, '0')}</span>
                      <span>{rule}</span>
                    </li>
                  ))}
                </ol>
                <p className={ui.cardText}>
                  A signature that lands between the registry call and the vault freeze makes the listing fail. Marketplace sales through{' '}
                  <code className={ui.code}>nft_transfer_payout</code> meet the same check.
                </p>
              </div>
              <div className={`${ui.glass} ${ui.glassLit} ${ui.card} ${ui.reveal}`}>
                <h3 className={ui.subhead}>Agent firewall</h3>
                <p className={ui.cardText}>
                  The operator is treated as compromised. It sends structured fields and never bytes to sign. The vault checks them in this
                  order and writes the signed payload itself.
                </p>
                <ul className={ui.checks}>
                  {FIREWALL.map(([check, error]) => (
                    <li key={error} className={ui.check}>
                      <span className={ui.checkText}>{check}</span>
                      <code className={ui.codeQuiet}>{error}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <h3 className={`${ui.subhead} ${ui.spacer}`}>Who can do what</h3>
            <div className={ui.body}>
              <GlassTable head={['Actor', 'Can', 'Cannot']} rows={ACTORS} />
            </div>

            <h3 className={`${ui.subhead} ${ui.spacer}`}>Known limits</h3>
            <ul className={ui.limits}>
              {LIMITS.map((limit) => (
                <li key={limit} className={`${ui.limit} ${ui.reveal}`}>
                  {limit}
                </li>
              ))}
            </ul>
          </Section>

          <Section id="stack" index="05" label="Built on" title="Four NEAR primitives, each doing a specific job.">
            <div className={ui.primitives}>
              {PRIMITIVES.map(([name, id, body]) => (
                <div key={name} className={`${ui.glass} ${ui.hoverGlow} ${ui.primitive} ${ui.reveal}`}>
                  <div className={ui.primIcon}>{ICONS[name]}</div>
                  <h3 className={ui.primName}>{name}</h3>
                  <code className={`${ui.code} ${ui.primId}`}>{id}</code>
                  <p className={ui.primBody}>{body}</p>
                </div>
              ))}
            </div>
            <div className={ui.chips}>
              {['NEP-171', 'NEP-177 on-chain SVG charter', 'NEP-178', 'NEP-181', 'NEP-199 royalties', 'NEP-297 events'].map((standard) => (
                <span key={standard} className={ui.chip}>
                  {standard}
                </span>
              ))}
            </div>
          </Section>

          <Section
            id="status"
            index="06"
            label="Build status"
            title="What runs today, and what does not yet."
            intro="This list is here so you do not have to work it out from the code."
          >
            <div className={`${ui.glass} ${ui.statusList} ${ui.reveal}`}>
              {STATUS.map(([item, detail, level]) => (
                <div key={item} className={ui.statusRow}>
                  <span className={ui.statusItem}>{item}</span>
                  <span className={ui.statusDetail}>{detail}</span>
                  <span className={`${ui.badge} ${STATUS_STYLES[level].className}`}>{STATUS_STYLES[level].label}</span>
                </div>
              ))}
            </div>
          </Section>

          <section className={ui.closing}>
            <div className={ui.reveal}>
              <p className={ui.eyebrow}>
                <span className={ui.eyebrowIndex}>07</span>
                Open the registry
              </p>
              <h2 className={ui.closingTitle}>
                <span>Incorporate one,</span>
                <span>or buy one outright.</span>
              </h2>
              <p className={ui.closingText}>
                Every company on the exchange shows its booked revenue, retained earnings, state and ask, read from its vault.
              </p>
              <div className={ui.closingActions}>
                <Link href="/exchange" className={ui.cta}>
                  Launch App
                </Link>
                <a href="#how-it-works" className={ui.secondary}>
                  How it works
                </a>
              </div>
            </div>
            <div className={ui.terminalStage}>
              <div className={`${ui.glass} ${ui.glassLit} ${ui.terminal}`}>
                <div className={ui.terminalBar}>
                  <strong>lifecycle</strong>
                  <span>{registryId ?? 'no registry configured'}</span>
                </div>
                <div className={ui.terminalBody}>
                  <p className={ui.tComment}>{'// the five calls a company passes through'}</p>
                  {LIFECYCLE.map((item) => (
                    <p key={item.step} className={ui.tLine}>
                      <span className={ui.tPrompt}>{'>'}</span>
                      <span>
                        <span className={ui.tMethod}>{item.method}</span>
                        <span className={ui.tComment}>{`  // ${item.title.toLowerCase()}`}</span>
                      </span>
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </section>

          <SiteFooter onLanding />
        </div>
      </main>
    </>
  );
}
