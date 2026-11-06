'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { describeActionError, incorporate, validateIncorporate, type ActionError } from '@/lib/actions';
import { RegistryClient, type Incorporate } from '@/lib/contracts';
import { describeContractError, awaitFinalTransaction } from '@/lib/txOutcome';
import { readWalletRedirect, useWallet, type WalletRedirectResult } from '@/lib/wallet';
import { Address, Button, Field, Glass, Input, Notice, Textarea, TxResult } from '../ui';
import { MAX_TEXT_BYTES, buildArgs, formatBps, formatNear, formatUsdc, parseDecimal, utf8Length, type FieldErrors, type FormValues } from './format';
import { IncorporatedResult, type Incorporated } from './result';
import s from './incorporate.module.css';

const STEPS = [
  { id: 'company', label: 'Company', fields: ['name', 'template'] },
  { id: 'economics', label: 'Economics', fields: ['price', 'reserve', 'royalty'] },
  { id: 'treasury', label: 'Treasury', fields: ['btc', 'sol', 'usdc', 'targets'] },
  { id: 'review', label: 'Review and sign', fields: [] },
] as const;

const DEFAULTS: FormValues = { name: '', template: '', price: '0.05', reserve: '20', royalty: '5', btc: '40', sol: '30', usdc: '30' };

/** Service instructions the deploy script incorporates on mainnet (scripts/lib/plan.mjs). */
const TEMPLATES: { label: string; text: string }[] = [
  { label: 'Contract audit', text: 'Audit this smart contract. List each bug, its severity, a fix.' },
  { label: 'Translation', text: 'Translate the text into English. Reply with the translation.' },
  { label: 'Summary', text: 'Summarize the text in three bullet points of at most 20 words.' },
];

const FORM_KEY = 'incorpr.incorporate.form';
const GAS_TGAS = 300;

type Cost =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ok'; yocto: string; readAt: string }
  | { status: 'error'; message: string };

type Phase =
  | { kind: 'form' }
  | { kind: 'signing' }
  | { kind: 'confirming'; hash: string }
  | { kind: 'failed'; error: ActionError }
  | { kind: 'done'; result: Incorporated };

export type InitialCost = { yocto: string; readAt: string } | { error: string } | null;

function readStoredForm(): FormValues | null {
  try {
    const raw = window.sessionStorage.getItem(FORM_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<FormValues>) } : null;
  } catch {
    return null;
  }
}

function stepHasError(index: number, errors: FieldErrors): boolean {
  return (STEPS[index]?.fields ?? []).some((f) => errors[f as keyof FieldErrors]);
}

export function IncorporateWizard({
  network,
  registryId,
  initialCost,
}: {
  network: string;
  registryId: string | null;
  initialCost: InitialCost;
}) {
  const wallet = useWallet();
  const [values, setValues] = useState<FormValues>(DEFAULTS);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [shown, setShown] = useState<Set<number>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  const [cost, setCost] = useState<Cost>(() => {
    if (!registryId) return { status: 'none' };
    if (!initialCost) return { status: 'loading' };
    return 'error' in initialCost ? { status: 'error', message: initialCost.error } : { status: 'ok', ...initialCost };
  });
  const [redirect, setRedirect] = useState<WalletRedirectResult | null>(null);
  const redirectHandled = useRef(false);

  const { args, errors } = useMemo(() => buildArgs(values), [values]);

  // Restore the form after a redirecting wallet returns, and pick up its transaction hashes.
  useEffect(() => {
    const stored = readStoredForm();
    if (stored) setValues(stored);
    const result = readWalletRedirect();
    if (result) {
      setRedirect(result);
      setStep(3);
      setReached(3);
    }
  }, []);

  const readCost = useCallback(async () => {
    if (!registryId) return;
    setCost({ status: 'loading' });
    try {
      const yocto = await new RegistryClient(registryId).incorporationCost();
      setCost({ status: 'ok', yocto, readAt: new Date().toISOString() });
    } catch (error) {
      setCost({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }, [registryId]);

  // The deposit is read again whenever the review step opens, so the figure signed is current.
  useEffect(() => {
    if (step === 3) void readCost();
  }, [step, readCost]);

  const finishFromChain = useCallback(
    async (hash: string, signer: string, deposit: string | null) => {
      if (!registryId) return;
      setPhase({ kind: 'confirming', hash });
      try {
        const outcome = await awaitFinalTransaction<string | null>(hash, signer);
        if (typeof outcome.value !== 'string') {
          setPhase({
            kind: 'failed',
            error: {
              code: null,
              kind: 'contract',
              message: 'The registry could not create the company account and refunded the deposit.',
              raw: JSON.stringify(outcome.value),
              txHash: hash,
            },
          });
          return;
        }
        const company = await new RegistryClient(registryId, { finality: 'optimistic' }).getCompany(outcome.value);
        if (!company) throw new Error(`Token ${outcome.value} was minted but get_company returned nothing yet. Reload in a few seconds.`);
        window.sessionStorage.removeItem(FORM_KEY);
        setPhase({ kind: 'done', result: { txHashes: [hash], tokenId: outcome.value, vault: company.vault, deposit, company } });
      } catch (error) {
        setPhase({ kind: 'failed', error: describeActionError(error) });
      }
    },
    [registryId],
  );

  // A redirecting wallet: wait until the account is known, then read the transaction from chain.
  useEffect(() => {
    if (!redirect || redirectHandled.current) return;
    if (redirect.errorCode || redirect.txHashes.length === 0) {
      redirectHandled.current = true;
      const error = describeContractError(redirect.errorCode ?? 'The wallet returned without a transaction');
      setPhase({
        kind: 'failed',
        error: {
          ...error,
          kind: 'rejected',
          message: redirect.errorCode === 'userRejected' ? 'The wallet request was rejected. Nothing was signed.' : error.message,
          txHash: null,
        },
      });
      return;
    }
    if (!wallet.accountId) return;
    redirectHandled.current = true;
    const hash = redirect.txHashes[redirect.txHashes.length - 1] as string;
    void finishFromChain(hash, wallet.accountId, null);
  }, [redirect, wallet.accountId, finishFromChain]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function goTo(index: number) {
    setStep(index);
    setReached((r) => Math.max(r, index));
  }

  function next() {
    setShown((set) => new Set(set).add(step));
    if (stepHasError(step, errors)) return;
    goTo(step + 1);
  }

  async function submit() {
    if (!args || !wallet.sender || !registryId) return;
    const invalid = validateIncorporate(args);
    if (invalid) {
      setPhase({ kind: 'failed', error: { ...describeContractError(invalid), txHash: null } });
      return;
    }
    window.sessionStorage.setItem(FORM_KEY, JSON.stringify(values));
    setPhase({ kind: 'signing' });
    try {
      const result = await incorporate(wallet.sender, args, { registryId });
      window.sessionStorage.removeItem(FORM_KEY);
      setPhase({ kind: 'done', result });
    } catch (error) {
      // A redirecting wallet navigates away; the result is read when it returns to this page.
      if (error instanceof Error && error.name === 'WalletRedirectError') return;
      setPhase({ kind: 'failed', error: describeActionError(error) });
    }
  }

  function reset() {
    setValues(DEFAULTS);
    setStep(0);
    setReached(0);
    setShown(new Set());
    setPhase({ kind: 'form' });
    setRedirect(null);
  }

  if (phase.kind === 'done' && registryId) {
    return <IncorporatedResult result={phase.result} registryId={registryId} onReset={reset} />;
  }

  const showErrors = (index: number) => shown.has(index);
  const err = (key: keyof FieldErrors, index: number) => (showErrors(index) ? errors[key] : undefined);

  return (
    <div className={s.layout}>
      <div className={s.main}>
        <ol className={s.stepper} aria-label="Steps">
          {STEPS.map((item, i) => {
            const active = i === step;
            const done = i < reached || (i < step && !stepHasError(i, errors));
            return (
              <li key={item.id} className={s.stepItem}>
                <button
                  type="button"
                  className={`${s.stepBtn} ${active ? s.stepActive : ''} ${done && !active ? s.stepDone : ''}`}
                  aria-current={active ? 'step' : undefined}
                  disabled={i > reached || phase.kind === 'signing' || phase.kind === 'confirming'}
                  onClick={() => goTo(i)}
                >
                  <span className={s.stepNo}>{String(i + 1).padStart(2, '0')}</span>
                  {item.label}
                </button>
              </li>
            );
          })}
        </ol>

        <Glass lit pad="lg">
          {step === 0 && (
            <StepBody title="Name the company and its service" intro="Both are stored on-chain and printed on the NFT charter. The service instruction is the system prompt the NEAR AI Cloud model runs for every paid call.">
              <Field
                label={
                  <>
                    Company name <span className={`${s.counter} ${utf8Length(values.name) > MAX_TEXT_BYTES ? s.counterOver : ''}`}>{utf8Length(values.name)} / {MAX_TEXT_BYTES} bytes</span>
                  </>
                }
                htmlFor="name"
                error={err('name', 0)}
              >
                <Input
                  id="name"
                  value={values.name}
                  onChange={(e) => update('name', e.target.value)}
                  placeholder="Ledgerline Audit"
                  autoComplete="off"
                  invalid={Boolean(err('name', 0))}
                  aria-describedby={err('name', 0) ? 'name-error' : undefined}
                />
              </Field>
              <Field
                label={
                  <>
                    Service instruction <span className={`${s.counter} ${utf8Length(values.template) > MAX_TEXT_BYTES ? s.counterOver : ''}`}>{utf8Length(values.template)} / {MAX_TEXT_BYTES} bytes</span>
                  </>
                }
                htmlFor="template"
                hint="One line, at most 64 bytes. Customers send the input; the model answers under this instruction inside a TEE."
                error={err('template', 0)}
              >
                <Textarea
                  id="template"
                  value={values.template}
                  onChange={(e) => update('template', e.target.value.replace(/[\r\n]+/g, ' '))}
                  placeholder="Summarize the text in three bullet points of at most 20 words."
                  rows={3}
                  invalid={Boolean(err('template', 0))}
                  aria-describedby={err('template', 0) ? 'template-error' : 'template-hint'}
                />
              </Field>
              <div className={s.presets}>
                <span className={s.presetLabel}>Start from:</span>
                {TEMPLATES.map((t) => (
                  <button key={t.label} type="button" className={s.preset} onClick={() => update('template', t.text)}>
                    {t.label}
                  </button>
                ))}
              </div>
            </StepBody>
          )}

          {step === 1 && (
            <StepBody title="Set the price and the split" intro="Every payment is booked by the vault when the USDC arrives. No account can report revenue for the company.">
              <Field
                label="Price per call"
                htmlFor="price"
                hint="The vault refunds any payment below this amount in full."
                error={err('price', 1)}
              >
                <Input id="price" mono inputMode="decimal" suffix="USDC" value={values.price} onChange={(e) => update('price', e.target.value)} invalid={Boolean(err('price', 1))} />
              </Field>
              <div className={s.twoCol}>
                <Field
                  label="Compute reserve"
                  htmlFor="reserve"
                  hint="Share of each payment kept for compute bills, payable only to the compute payee. 1% to 100%."
                  error={err('reserve', 1)}
                >
                  <Input id="reserve" mono inputMode="decimal" suffix="%" value={values.reserve} onChange={(e) => update('reserve', e.target.value)} invalid={Boolean(err('reserve', 1))} />
                </Field>
                <Field
                  label="Founder royalty"
                  htmlFor="royalty"
                  hint="Paid to you on every later sale of the company (NEP-199). At most 10%."
                  error={err('royalty', 1)}
                >
                  <Input id="royalty" mono inputMode="decimal" suffix="%" value={values.royalty} onChange={(e) => update('royalty', e.target.value)} invalid={Boolean(err('royalty', 1))} />
                </Field>
              </div>
            </StepBody>
          )}

          {step === 2 && (
            <StepBody
              title="Set the treasury target"
              intro="The target split of retained earnings across Bitcoin, Solana and USDC. It is stored on-chain and printed on the charter. Rebalance execution is not in this release: the app shows dry 1Click quotes against it."
            >
              <div className={s.threeCol}>
                {(['btc', 'sol', 'usdc'] as const).map((key) => (
                  <Field key={key} label={key === 'btc' ? 'Bitcoin' : key === 'sol' ? 'Solana' : 'USDC'} htmlFor={key} error={err(key, 2)}>
                    <Input id={key} mono inputMode="decimal" suffix="%" value={values[key]} onChange={(e) => update(key, e.target.value)} invalid={Boolean(err(key, 2) || err('targets', 2))} />
                  </Field>
                ))}
              </div>
              <Allocation values={values} error={err('targets', 2) ?? null} />
            </StepBody>
          )}

          {step === 3 && (
            <ReviewStep
              args={args}
              cost={cost}
              registryId={registryId}
              network={network}
              phase={phase}
              onRetryCost={() => void readCost()}
              onSubmit={() => void submit()}
              onBack={() => {
                setPhase({ kind: 'form' });
                goTo(0);
              }}
            />
          )}

          {step < 3 && (
            <div className={s.actions}>
              {step > 0 ? (
                <Button variant="secondary" onClick={() => goTo(step - 1)}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              <div className={s.actionsRight}>
                <Button onClick={next} arrow>
                  {step === 2 ? 'Review' : 'Continue'}
                </Button>
              </div>
            </div>
          )}
        </Glass>
      </div>

      <aside className={s.aside} aria-label="The transaction this form builds">
        <CallPreview values={values} errors={errors} registryId={registryId} cost={cost} />
        <Glass pad="md">
          <div className={s.facts}>
            <p>
              <strong>One transaction.</strong> The registry creates <code>c-&lt;id&gt;.{registryId ?? '<registry>'}</code>, funds it, deploys the vault code and
              calls <code>new</code>. The NFT is minted only if all of that succeeds. Otherwise the deposit comes back.
            </p>
            <p>
              <strong>No access keys.</strong> The vault account is created without a key, so nobody holds a seed phrase for it. Check any vault on the{' '}
              <Link href="/verify" className="underline decoration-[rgba(240,162,76,0.4)] underline-offset-4 hover:text-[var(--ui-amber)]">
                verify page
              </Link>
              .
            </p>
            <p>
              <strong>Network: {network}.</strong> {network === 'mainnet' ? 'The deposit is real NEAR.' : 'NEAR on this network has no value.'}
            </p>
          </div>
        </Glass>
      </aside>
    </div>
  );
}

function StepBody({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <>
      <h2 className={s.stepTitle}>{title}</h2>
      <p className={s.stepIntro}>{intro}</p>
      <div className={s.fields}>{children}</div>
    </>
  );
}

function Allocation({ values, error }: { values: FormValues; error: string | null }) {
  const parts = [
    { key: 'btc', label: 'BTC', className: s.segBtc, color: 'var(--ui-peach)' },
    { key: 'sol', label: 'SOL', className: s.segSol, color: 'var(--ui-lilac)' },
    { key: 'usdc', label: 'USDC', className: s.segUsdc, color: 'var(--ui-teal)' },
  ] as const;
  const bps = parts.map((p) => Number(parseDecimal(values[p.key], 2) ?? 0n));
  const sum = bps.reduce((a, b) => a + b, 0);
  const scale = Math.max(sum, 10_000);
  return (
    <div className={s.allocation}>
      <div className={s.bar} role="img" aria-label={`Target ${parts.map((p, i) => `${formatBps(bps[i] ?? 0)} ${p.label}`).join(', ')}`}>
        {parts.map((p, i) => (
          <span key={p.key} className={`${s.seg} ${p.className}`} style={{ width: `${((bps[i] ?? 0) / scale) * 100}%` }} />
        ))}
      </div>
      <div className={s.legend}>
        {parts.map((p, i) => (
          <span key={p.key} className={s.legendItem}>
            <span className={s.dot} style={{ background: p.color }} />
            {p.label} {formatBps(bps[i] ?? 0)}
          </span>
        ))}
        <span className={sum === 10_000 ? s.sumOk : s.sumBad}>Sum {formatBps(sum)}</span>
      </div>
      {error && (
        <p className="text-[12.5px] leading-normal text-[var(--ui-coral)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ReviewStep({
  args,
  cost,
  registryId,
  network,
  phase,
  onRetryCost,
  onSubmit,
  onBack,
}: {
  args: Incorporate | null;
  cost: Cost;
  registryId: string | null;
  network: string;
  phase: Phase;
  onRetryCost: () => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const wallet = useWallet();
  const busy = phase.kind === 'signing' || phase.kind === 'confirming';
  const blocker = !registryId
    ? `No registry is configured for ${network}, so there is nothing to sign against.`
    : !args
      ? 'An earlier step has an invalid value. Go back and fix it.'
      : cost.status !== 'ok'
        ? 'The deposit could not be read from the registry.'
        : wallet.unavailableReason
          ? wallet.unavailableReason
          : null;

  return (
    <>
      <h2 className={s.stepTitle}>Review and sign</h2>
      <p className={s.stepIntro}>Your wallet signs one function call to the registry. The values below are the exact arguments.</p>

      {args && (
        <div className={s.fields}>
          <SummaryTable args={args} />
        </div>
      )}

      <div className={s.deposit}>
        <span className={s.depositLabel}>Attached deposit</span>
        {cost.status === 'ok' && <span className={s.depositValue}>{formatNear(cost.yocto)}</span>}
        {cost.status === 'loading' && <span className={s.depositValue}>Reading incorporation_cost()</span>}
        {cost.status === 'none' && <span className={s.depositValue}>Not available</span>}
        {cost.status === 'error' && <span className={s.depositValue}>Could not read</span>}
        <p className={s.depositNote}>
          {cost.status === 'ok' && (
            <>
              Read from <code>{registryId}.incorporation_cost()</code> at {new Date(cost.readAt).toLocaleTimeString()}: {cost.yocto} yoctoNEAR. It pays for the vault account&apos;s
              code and state storage, its operating balance, the NFT&apos;s storage and the vault&apos;s USDC registration. The registry refunds what it does not use.
              Gas: {GAS_TGAS} TGas.
            </>
          )}
          {cost.status === 'none' && <>No registry is configured, so the cost cannot be read.</>}
          {cost.status === 'error' && <>{cost.message}</>}
        </p>
        {cost.status === 'error' && (
          <div>
            <Button variant="quiet" size="sm" onClick={onRetryCost}>
              Read again
            </Button>
          </div>
        )}
      </div>

      {phase.kind === 'signing' && <div className={s.fields}><TxResult status="pending" title="Waiting for the wallet" message="Confirm the transaction in your wallet. This page waits for it to be final." /></div>}
      {phase.kind === 'confirming' && (
        <div className={s.fields}>
          <TxResult status="pending" title="Reading the transaction from chain" hash={phase.hash} message="The wallet returned. Waiting for the transaction to be final." />
        </div>
      )}
      {phase.kind === 'failed' && (
        <div className={s.fields}>
          <TxResult status="rejected" title="The company was not incorporated" hash={phase.error.txHash} code={phase.error.code} message={phase.error.message}>
            <div>
              <Button variant="secondary" size="sm" onClick={onBack}>
                Edit the form
              </Button>
            </div>
          </TxResult>
        </div>
      )}

      <div className={s.actions}>
        <div className={s.signer}>
          {wallet.accountId ? (
            <>
              Signing as <Address value={wallet.accountId} />
            </>
          ) : wallet.unavailableReason ? null : (
            <>No wallet connected.</>
          )}
        </div>
        <div className={s.actionsRight}>
          {!wallet.accountId && !wallet.unavailableReason ? (
            <Button onClick={wallet.signIn} disabled={!wallet.ready} arrow>
              Connect wallet
            </Button>
          ) : (
            <Button onClick={onSubmit} disabled={Boolean(blocker)} busy={busy} busyLabel="Signing" arrow>
              {cost.status === 'ok' ? `Incorporate for ${formatNear(cost.yocto)}` : 'Incorporate'}
            </Button>
          )}
        </div>
      </div>
      {blocker && phase.kind === 'form' && (
        <div className={s.fields}>
          <Notice tone="info" title="Signing is not available">
            {blocker}
          </Notice>
        </div>
      )}
    </>
  );
}

function SummaryTable({ args }: { args: Incorporate }) {
  const rows: [string, string][] = [
    ['Name', args.name],
    ['Service instruction', args.service_template],
    ['Price per call', `${formatUsdc(args.price_micro_usdc)} (${args.price_micro_usdc} micro-USDC)`],
    ['Compute reserve', `${formatBps(args.compute_reserve_bps)} (${args.compute_reserve_bps} bps)`],
    ['Founder royalty', `${formatBps(args.founder_royalty_bps)} (${args.founder_royalty_bps} bps)`],
    ['Treasury target', `${formatBps(args.target_bps[0])} BTC / ${formatBps(args.target_bps[1])} SOL / ${formatBps(args.target_bps[2])} USDC`],
  ];
  return (
    <dl className="grid">
      {rows.map(([label, value], i) => (
        <div key={label} className={`grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4 ${i ? 'border-t border-[var(--ui-hair)]' : 'pt-0'}`}>
          <dt className="text-[13px] text-[var(--ui-grey-2)]">{label}</dt>
          <dd className="min-w-0 break-words text-[14.5px] text-white [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------- Call preview

type Tok = { t: string; c?: string };

function CallPreview({ values, errors, registryId, cost }: { values: FormValues; errors: FieldErrors; registryId: string | null; cost: Cost }) {
  const str = (v: string, bad: boolean): Tok => ({ t: JSON.stringify(v), c: bad ? s.tBad : s.tStr });
  const num = (v: string, decimals: number, bad: boolean): Tok => {
    const parsed = parseDecimal(v, decimals);
    return { t: parsed === null ? JSON.stringify(v) : parsed.toString(), c: bad || parsed === null ? s.tBad : s.tNum };
  };
  const key = (k: string): Tok => ({ t: `"${k}"`, c: s.tKey });
  const p = (t: string): Tok => ({ t });
  const targetsBad = Boolean(errors.targets || errors.btc || errors.sol || errors.usdc);
  const priceTok = (() => {
    const parsed = parseDecimal(values.price, 6);
    return { t: JSON.stringify(parsed === null ? values.price : parsed.toString()), c: errors.price ? s.tBad : s.tStr };
  })();
  const lines: Tok[][] = [
    [{ t: `// ${registryId ?? 'no registry configured'}`, c: s.tComment }],
    [{ t: 'incorporate_company', c: s.tFn }, p('({')],
    [p('  '), key('args'), p(': {')],
    [p('    '), key('name'), p(': '), str(values.name, Boolean(errors.name)), p(',')],
    [p('    '), key('service_template'), p(': '), str(values.template, Boolean(errors.template)), p(',')],
    [p('    '), key('price_micro_usdc'), p(': '), priceTok, p(',')],
    [
      p('    '),
      key('target_bps'),
      p(': ['),
      num(values.btc, 2, targetsBad),
      p(', '),
      num(values.sol, 2, targetsBad),
      p(', '),
      num(values.usdc, 2, targetsBad),
      p('],'),
    ],
    [p('    '), key('founder_royalty_bps'), p(': '), num(values.royalty, 2, Boolean(errors.royalty)), p(',')],
    [p('    '), key('compute_reserve_bps'), p(': '), num(values.reserve, 2, Boolean(errors.reserve))],
    [p('  }')],
    [p('})')],
    [
      {
        t: `// deposit ${cost.status === 'ok' ? `${cost.yocto} yocto` : 'read from incorporation_cost() at review'}, gas ${GAS_TGAS} TGas`,
        c: s.tComment,
      },
    ],
  ];
  return (
    <Glass pad="none" className={s.preview}>
      <div className={s.previewBar}>
        <span className={s.previewTab}>function call</span>
        <span>{Object.keys(errors).length ? `${Object.keys(errors).length} to fix` : 'valid'}</span>
      </div>
      <pre className={s.code} aria-label="Arguments of the incorporate_company call">
        {lines.map((line, i) => (
          <span key={i} className="block">
            {line.map((tok, j) => (
              <span key={j} className={tok.c}>
                {tok.t}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </Glass>
  );
}

