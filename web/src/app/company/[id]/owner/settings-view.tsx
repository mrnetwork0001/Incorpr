// Vault settings, read from get_state on this render. Server component.

import type { CompanyView, Policy, VaultState } from '@/lib/contracts';
import { Address, KeyValue, type KeyValueItem } from '../../../ui';
import { assetName, bpsToPercent, formatAsset, formatTime, formatUsdc } from '../format';
import s from './owner.module.css';

function List({ items }: { items: string[] }) {
  if (items.length === 0) return <span className={s.mutedSmall}>none</span>;
  return (
    <ul className={s.valueList}>
      {items.map((item) => (
        <li key={item} className={s.mono}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function policyItems(policy: Policy, state: VaultState): KeyValueItem[] {
  const usdc = state.usdc_token;
  const spent = new Map(state.spent_this_window);
  return [
    { label: 'Operator', value: <Address value={policy.operator} /> },
    { label: 'Allowed tokens', value: <List items={policy.allowed_tokens.map((t) => `${assetName(t, usdc)}  ${t}`)} /> },
    {
      label: 'Epoch caps',
      value: (
        <List
          items={policy.epoch_caps.map(([token, cap]) => `${formatAsset(cap, token, usdc)} per 24 h window, ${formatAsset(spent.get(token) ?? '0', token, usdc)} spent in window ${state.spend_window}`)}
        />
      ),
    },
    {
      label: 'Price floors',
      value: (
        <List
          items={policy.price_floors.map(
            (f) => `${assetName(f.sell_token, usdc)} to ${assetName(f.buy_token, usdc)}: at least ${formatAsset(f.min_buy, f.buy_token, usdc)} per ${formatAsset(f.per_sell, f.sell_token, usdc)}`,
          )}
        />
      ),
    },
    { label: 'TEE signers', value: <List items={policy.tee_signers} /> },
    { label: 'TEE models', value: <List items={policy.tee_models} /> },
    { label: 'Prompt hash', value: policy.tee_prompt_hash || 'not pinned', mono: true },
  ];
}

export function SettingsView({ company, state }: { company: CompanyView; state: VaultState }) {
  const samePolicy = JSON.stringify(state.policy) === JSON.stringify(state.default_policy);
  return (
    <div className={s.stack}>
      <KeyValue
        items={[
          { label: 'Vault', value: <Address value={company.vault} /> },
          { label: 'Shareholder', value: <Address value={state.shareholder} /> },
          { label: 'Price', value: `${formatUsdc(state.price_micro_usdc)} USDC per call`, mono: true },
          { label: 'Compute reserve', value: `${bpsToPercent(state.compute_reserve_bps)} of each payment`, mono: true },
          { label: 'Compute payee', value: <Address value={state.compute_payee} /> },
          {
            label: 'Founder royalty',
            value: (
              <span className={s.stackTight}>
                <Address value={state.founder} />
                <span className={s.mutedSmall}>{bpsToPercent(state.founder_royalty_bps)} of every sale</span>
              </span>
            ),
          },
          { label: 'Treasury epoch', value: `${state.treasury_epoch}, ${state.raw_sigs_this_epoch} raw signature(s) this epoch`, mono: true },
          { label: 'Owner generation', value: `${state.owner_generation}, sync nonce ${state.sync_nonce}`, mono: true },
          {
            label: 'Intents key',
            value: state.intents_key_registered ? `registered on ${state.intents_contract}` : `not registered on ${state.intents_contract}`,
            mono: true,
          },
          { label: 'Last intent deadline', value: formatTime(state.latest_intent_deadline_ms), mono: true },
          { label: 'Signer', value: state.mpc_contract, mono: true },
        ]}
      />

      <h3 className={s.subTitle}>Agent policy in force while free</h3>
      <KeyValue items={policyItems(state.policy, state)} />

      {samePolicy ? (
        <p className={s.mutedSmall}>
          The charter policy (default_policy), which the vault uses while listed, pledged or in transit, is identical to the policy above.
        </p>
      ) : (
        <>
          <h3 className={s.subTitle}>Charter policy while listed, pledged or in transit</h3>
          <KeyValue items={policyItems(state.default_policy, state)} />
        </>
      )}
      <p className={s.mutedSmall}>
        These values are on-chain and any account can read them with get_state. The room groups them for the holder, who is the only account the vault
        lets change them (set_operator, set_tee_signers, set_policy, set_tee_policy, set_price_floors, all while free).
      </p>
    </div>
  );
}
