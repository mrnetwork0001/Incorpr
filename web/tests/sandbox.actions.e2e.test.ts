// The wallet actions in src/lib/actions.ts, end to end against a local near-sandbox chain running the
// compiled contracts. Each action runs exactly as in the browser, except that the TxSender signs with
// a local key instead of a wallet (sandboxHarness.ts `sender`). Outcomes are read from contract state.
//
// SANDBOX LIMITS: signing goes through contracts/test-doubles/mpc-signer, and intents.near is
// contracts/test-doubles/intents. USDC is contracts/test-doubles/test-usdc, a NEP-141 token.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ActionRefusedError,
  acceptOffer,
  bidAuction,
  buyCompany,
  cancelOffer,
  claimDefaultedCollateral,
  claimDividends,
  describeActionError,
  fundOffer,
  incorporate,
  listCompany,
  payForService,
  refreshTreasuryKeys,
  repayLoan,
  requestRawSignature,
  rotateTreasuryEpoch,
  startAuction,
  unlistCompany,
  withdrawPending,
} from '@/lib/actions';
import { RegistryClient, VaultClient, ftViews, serviceCallId, usdcCalls } from '@/lib/contracts';
import { TransactionFailedError } from '@/lib/txOutcome';
import { chain, findSandboxBinary, startSandbox, type Sandbox } from './sandboxHarness';

const binary = findSandboxBinary();
const USDC = 'usdc.test.near';
const USDC_ASSET = `nep141:${USDC}`;
const REGISTRY = 'registry.test.near';
const VAULT = `c-1.${REGISTRY}`;
const FOUNDER = 'founder.test.near';
const CUSTOMER = 'customer.test.near';
const BUYER = 'buyer.test.near';
const LENDER = 'lender.test.near';
const PRICE = '2000000';
const ASK = '50000000';

let sandbox: Sandbox | undefined;
let tx: ReturnType<typeof chain>;
const options = { registryId: REGISTRY };
const savedRpc = process.env.NEXT_PUBLIC_NEAR_RPC_URL;

const usdcBalance = async (who: string) => BigInt(await ftViews.balanceOf(USDC, who, { finality: 'optimistic' }));

describe.skipIf(!binary)('wallet actions against the compiled contracts', () => {
  beforeAll(async () => {
    sandbox = await startSandbox(binary as string);
    process.env.NEXT_PUBLIC_NEAR_RPC_URL = sandbox.rpcUrl;
    tx = chain(sandbox);
    const { createAccount, send, raw } = tx;

    await createAccount(USDC, 30n, 'test_usdc.wasm');
    await createAccount('mpc.test.near', 30n, 'mpc_signer_double.wasm');
    await createAccount('intents.test.near', 30n, 'intents_double.wasm');
    await createAccount('operator.test.near', 10n);
    await createAccount('payee.test.near', 10n);
    await createAccount(FOUNDER, 40n);
    await createAccount(CUSTOMER, 10n);
    await createAccount(BUYER, 20n);
    await createAccount(LENDER, 10n);
    await createAccount(REGISTRY, 50n, 'incorpr_registry.wasm');
    await send(USDC, raw(USDC, 'new', {}));
    await send('mpc.test.near', raw('mpc.test.near', 'new', {}));
    await send('intents.test.near', raw('intents.test.near', 'new', {}));
    await send(
      REGISTRY,
      raw(REGISTRY, 'new', {
        args: {
          owner: REGISTRY,
          usdc_token: USDC,
          mpc_contract: 'mpc.test.near',
          intents_contract: 'intents.test.near',
          btc_hrp: 'tb',
          default_operator: 'operator.test.near',
          compute_payee: 'payee.test.near',
          allowed_tokens: [USDC_ASSET],
          epoch_caps: [[USDC_ASSET, '1000000000']],
          tee_signers: [],
          tee_models: ['m'],
          tee_prompt_hash: '0'.repeat(64),
          price_floors: [],
          auction_duration_ms: 3_600_000,
        },
      }),
    );
    // The founder is deliberately not registered on USDC: the actions must register it themselves.
    for (const who of ['payee.test.near', CUSTOMER, BUYER, LENDER]) {
      await send(CUSTOMER, raw(USDC, 'storage_deposit', { account_id: who }, '1250000000000000000000'));
    }
    for (const who of [CUSTOMER, BUYER, LENDER]) {
      await send(USDC, raw(USDC, 'mint', { account_id: who, amount: '100000000' }));
    }
  }, 180_000);

  afterAll(() => {
    sandbox?.stop();
    if (savedRpc === undefined) delete process.env.NEXT_PUBLIC_NEAR_RPC_URL;
    else process.env.NEXT_PUBLIC_NEAR_RPC_URL = savedRpc;
  });

  it('incorporate: attaches incorporation_cost and returns the token id and vault', async () => {
    const result = await incorporate(
      tx.sender(FOUNDER),
      {
        name: 'Acme Translate',
        service_template: 'Translate the text you receive.',
        price_micro_usdc: PRICE,
        target_bps: [5000, 2500, 2500],
        founder_royalty_bps: 100,
        compute_reserve_bps: 1000,
      },
      options,
    );
    expect(result.tokenId).toBe('1');
    expect(result.vault).toBe(VAULT);
    expect(result.deposit).toBe(await new RegistryClient(REGISTRY).incorporationCost());
    expect(result.txHashes).toHaveLength(1);
    expect(result.company.owner_id).toBe(FOUNDER);
  });

  it('payForService: books the payment, and reports booked only from get_payment', async () => {
    const result = await payForService(tx.sender(CUSTOMER), { tokenId: '1', input: 'hello' }, options);
    expect(result.booked).toBe(true);
    expect(result.amount).toBe(PRICE);
    expect(result.callId).toBe(serviceCallId('hello', result.salt));
    expect(result.payment).toMatchObject({ payer: CUSTOMER, amount: PRICE, served: false });

    await expect(payForService(tx.sender(CUSTOMER), { tokenId: '1', input: 'hello', salt: result.salt }, options)).rejects.toBeInstanceOf(
      ActionRefusedError,
    );
  });

  it('an underpayment succeeds as a transaction and is refunded, so nothing is booked', async () => {
    const before = await usdcBalance(CUSTOMER);
    const callId = serviceCallId('cheap', 'salt-under');
    const [result] = await tx.sender(CUSTOMER).send([usdcCalls.payForService(USDC, VAULT, '1', callId)]);
    expect(result?.txHash).toBeTruthy();
    expect(await new VaultClient(VAULT, { finality: 'optimistic' }).getPayment(callId)).toBeNull();
    expect(await usdcBalance(CUSTOMER)).toBe(before);
  });

  it('claimDividends: registers the founder on USDC first, then pays', async () => {
    const result = await claimDividends(tx.sender(FOUNDER), '1', '1000000', options);
    expect(result.txHashes).toHaveLength(2);
    expect(result.paid).toBe(true);
    expect(await usdcBalance(FOUNDER)).toBe(1_000_000n);
  });

  it('requestRawSignature: returns the signer response and marks the epoch dirty', async () => {
    const result = await requestRawSignature(
      tx.sender(FOUNDER),
      { tokenId: '1', domainId: 0, payloadHex: 'ab'.repeat(32), subpath: 'treasury' },
      options,
    );
    expect(result.signature).toMatchObject({ scheme: 'Secp256k1' });
    expect(result.epochDirty).toBe(true);
    await expect(listCompany(tx.sender(FOUNDER), '1', ASK, options)).rejects.toThrow(/Rotate the treasury epoch/);
  });

  it('a list sent past the pre-check fails on-chain, and the parser reports the vault code as the cause', async () => {
    const error = await tx
      .sender(FOUNDER)
      .send([new RegistryClient(REGISTRY).listCompany('1', ASK)])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    // The registry's own follow-up failures (ERR_VAULT_FREEZE_FAILED, ERR_SETTLEMENT_FAILED) come later.
    expect((error as TransactionFailedError).code).toBe('ERR_RAW_SIGNATURES_THIS_EPOCH');
    expect(describeActionError(error)).toMatchObject({ code: 'ERR_RAW_SIGNATURES_THIS_EPOCH', kind: 'contract' });
    expect(describeActionError(error).txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const company = await new RegistryClient(REGISTRY, { finality: 'optimistic' }).getCompany('1');
    expect(company).toMatchObject({ encumbrance: 'Free', settling: false, needs_resync: false });
  });

  it('rotateTreasuryEpoch: moves to epoch 1 with fresh addresses', async () => {
    const result = await rotateTreasuryEpoch(tx.sender(FOUNDER), '1', options);
    expect(result.epoch).toBe(1);
    expect(result.addresses?.btc).toMatch(/^tb1q/);
    expect((await new VaultClient(VAULT).getState()).raw_sigs_this_epoch).toBe(0);
  });

  it('refreshTreasuryKeys: permissionless, re-derives the current epoch addresses', async () => {
    const before = await new VaultClient(VAULT).getState();
    const result = await refreshTreasuryKeys(tx.sender(CUSTOMER), '1', options);
    expect(result.txHashes).toHaveLength(1);
    expect(result.epoch).toBe(1);
    expect(result.addresses).toEqual(before.addresses);
  });

  it('listCompany freezes the vault: the owner cannot claim dividends while listed', async () => {
    const listed = await listCompany(tx.sender(FOUNDER), '1', ASK, options);
    expect(listed.listed).toBe(true);
    expect(listed.listing).toMatchObject({ seller: FOUNDER, ask: ASK });

    const error = await claimDividends(tx.sender(FOUNDER), '1', '1', options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionFailedError);
    expect((error as TransactionFailedError).reason).toBe('ERR_ACCOUNT_ENCUMBERED_CLAIM_FROZEN');
    expect((error as TransactionFailedError).txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it('unlistCompany releases the freeze', async () => {
    const result = await unlistCompany(tx.sender(FOUNDER), '1', options);
    expect(result.unlisted).toBe(true);
  });

  it('an acquire against a stale sync nonce succeeds as a transaction, refunds, and carries ERR_LISTING_CHANGED', async () => {
    await listCompany(tx.sender(FOUNDER), '1', ASK, options);
    const listing = await new RegistryClient(REGISTRY, { finality: 'optimistic' }).getListing('1');
    const before = await usdcBalance(BUYER);
    const [result] = await tx
      .sender(BUYER)
      .send([usdcCalls.acquire(USDC, REGISTRY, ASK, '1', (listing?.sync_nonce ?? 0) + 100)]);
    expect(result?.refusal).toMatchObject({ code: 'ERR_LISTING_CHANGED' });
    expect(await usdcBalance(BUYER)).toBe(before);
    expect((await new RegistryClient(REGISTRY).nftToken('1'))?.owner_id).toBe(FOUNDER);
    await unlistCompany(tx.sender(FOUNDER), '1', options);
  });

  it('buyCompany: one ft_transfer_call moves the NFT and the vault to the buyer', async () => {
    await listCompany(tx.sender(FOUNDER), '1', ASK, options);
    const sellerBefore = await usdcBalance(FOUNDER);
    const buyerBefore = await usdcBalance(BUYER);
    const listing = await new RegistryClient(REGISTRY, { finality: 'optimistic' }).getListing('1');
    // A buyer who confirmed a different ask is refused before anything is signed.
    const stale = await buyCompany(tx.sender(BUYER), '1', { ...options, expected: { ask: '1', syncNonce: listing?.sync_nonce } }).catch(
      (e: unknown) => e,
    );
    expect(stale).toBeInstanceOf(ActionRefusedError);
    expect((stale as ActionRefusedError).code).toBe('ERR_LISTING_CHANGED');
    expect(await usdcBalance(BUYER)).toBe(buyerBefore);
    const result = await buyCompany(tx.sender(BUYER), '1', {
      ...options,
      expected: { ask: ASK, syncNonce: listing?.sync_nonce },
    });
    expect(result.acquired).toBe(true);
    expect(result.owner).toBe(BUYER);
    expect(await usdcBalance(BUYER)).toBe(buyerBefore - BigInt(ASK));
    expect(await usdcBalance(FOUNDER)).toBeGreaterThan(sellerBefore);
    const state = await new VaultClient(VAULT).getState();
    expect(state.shareholder).toBe(BUYER);
    expect(state.encumbrance).toBe('Free');
  });

  let offerId = -1;

  it('fundOffer: pays registry storage first, then escrows the principal', async () => {
    const result = await fundOffer(
      tx.sender(LENDER),
      { tokenId: '1', principal: '10000000', repayAmount: '11000000', termMs: 3_600_000 },
      options,
    );
    expect(result.txHashes).toHaveLength(2);
    expect(result.offer).toMatchObject({ lender: LENDER, principal: '10000000', repay_amount: '11000000' });
    offerId = (result.offer as { id: number }).id;
  });

  it('acceptOffer: pledges the company and pays the principal to the owner', async () => {
    const before = await usdcBalance(BUYER);
    const result = await acceptOffer(tx.sender(BUYER), '1', offerId, options);
    expect(result.borrowed).toBe(true);
    expect(result.loan).toMatchObject({ borrower: BUYER, lender: LENDER, debt: '11000000' });
    expect(await usdcBalance(BUYER)).toBe(before + 10_000_000n);
    expect((await new VaultClient(VAULT).getState()).encumbrance).toMatchObject({ Pledged: { lender: LENDER } });
  });

  it('repayLoan: pays the debt and unfreezes the vault', async () => {
    const lenderBefore = await usdcBalance(LENDER);
    const result = await repayLoan(tx.sender(BUYER), '1', options);
    expect(result.repaid).toBe(true);
    expect(await usdcBalance(LENDER)).toBe(lenderBefore + 11_000_000n);
    expect((await new VaultClient(VAULT).getState()).encumbrance).toBe('Free');
  });

  it('cancelOffer: returns an unaccepted offer', async () => {
    const funded = await fundOffer(
      tx.sender(LENDER),
      { tokenId: '1', principal: '1000000', repayAmount: '1000000', termMs: 60_000 },
      options,
    );
    const before = await usdcBalance(LENDER);
    const result = await cancelOffer(tx.sender(LENDER), '1', (funded.offer as { id: number }).id, options);
    expect(result.cancelled).toBe(true);
    expect(await usdcBalance(LENDER)).toBe(before + 1_000_000n);
  });

  it('withdrawPending: refuses without signing when every receiver was registered', async () => {
    expect(await new RegistryClient(REGISTRY).pendingWithdrawal(FOUNDER)).toBe('0');
    await expect(withdrawPending(tx.sender(FOUNDER), options)).rejects.toBeInstanceOf(ActionRefusedError);
  });

  // A second registry with an 8 s auction window, so a default runs to the end inside the test.
  const SHORT = 'short.test.near';
  const shortOptions = { registryId: SHORT };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function defaultedLoan(): Promise<string> {
    const company = await incorporate(
      tx.sender(FOUNDER),
      {
        name: 'Short Term Co',
        service_template: 'Summarize the text you receive.',
        price_micro_usdc: PRICE,
        target_bps: [0, 0, 10000],
        founder_royalty_bps: 0,
        compute_reserve_bps: 100,
      },
      shortOptions,
    );
    const funded = await fundOffer(
      tx.sender(LENDER),
      { tokenId: company.tokenId, principal: '1000000', repayAmount: '1000000', termMs: 1 },
      shortOptions,
    );
    const borrowed = await acceptOffer(tx.sender(FOUNDER), company.tokenId, (funded.offer as { id: number }).id, shortOptions);
    expect(borrowed.borrowed).toBe(true);
    await sleep(1_500);
    // Permissionless: a third party starts the auction once the loan is past due.
    const started = await startAuction(tx.sender(CUSTOMER), company.tokenId, shortOptions);
    expect(BigInt(started.price ?? '0')).toBeGreaterThan(0n);
    return company.tokenId;
  }

  it('default: after the auction window closes, the lender claims the company and its vault', async () => {
    await tx.createAccount(SHORT, 30n, 'incorpr_registry.wasm');
    await tx.send(
      SHORT,
      tx.raw(SHORT, 'new', {
        args: {
          owner: SHORT,
          usdc_token: USDC,
          mpc_contract: 'mpc.test.near',
          intents_contract: 'intents.test.near',
          btc_hrp: 'tb',
          default_operator: 'operator.test.near',
          compute_payee: 'payee.test.near',
          allowed_tokens: [USDC_ASSET],
          epoch_caps: [[USDC_ASSET, '1000000000']],
          tee_signers: [],
          tee_models: ['m'],
          tee_prompt_hash: '0'.repeat(64),
          price_floors: [],
          auction_duration_ms: 8_000,
        },
      }),
    );
    const tokenId = await defaultedLoan();
    await expect(claimDefaultedCollateral(tx.sender(FOUNDER), tokenId, shortOptions)).rejects.toMatchObject({
      code: 'ERR_NOT_LOAN_LENDER',
    });
    const early = await tx
      .sender(LENDER)
      .send([new RegistryClient(SHORT).claimDefaultedCollateral(tokenId)])
      .catch((e: unknown) => e);
    expect((early as TransactionFailedError).code).toBe('ERR_AUCTION_STILL_OPEN');
    await sleep(8_500);
    const claimed = await claimDefaultedCollateral(tx.sender(LENDER), tokenId, shortOptions);
    expect(claimed.claimed).toBe(true);
    const state = await new VaultClient(`c-${tokenId}.${SHORT}`).getState();
    expect(state.shareholder).toBe(LENDER);
    expect(state.encumbrance).toBe('Free');
    expect(await new RegistryClient(SHORT).getLoan(tokenId)).toBeNull();
  });

  it('default: a bid during the auction buys the company, pays the lender and returns the excess', async () => {
    const tokenId = await defaultedLoan();
    const lenderBefore = await usdcBalance(LENDER);
    const result = await bidAuction(tx.sender(BUYER), tokenId, shortOptions);
    expect(result.acquired).toBe(true);
    expect(result.refusal).toBeNull();
    expect(await usdcBalance(LENDER)).toBe(lenderBefore + 1_000_000n);
    expect((await new VaultClient(`c-${tokenId}.${SHORT}`).getState()).shareholder).toBe(BUYER);
  });
});
