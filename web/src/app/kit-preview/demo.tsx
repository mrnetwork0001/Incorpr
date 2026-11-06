'use client';

import { useState } from 'react';
import { Button, Field, Input, Select, Tabs, Textarea, useToast } from '../ui';

export function ToastDemo() {
  const toast = useToast();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <Button variant="quiet" size="sm" onClick={() => toast.show({ tone: 'ok', title: 'Listed c-1', hash: '8Yk2xZ7dWq1a9QpTt3oJcV5mLrNs4bHfEgD6uK2iPw9A' })}>
        Toast ok
      </Button>
      <Button variant="quiet" size="sm" onClick={() => toast.show({ tone: 'error', title: 'Listing refused', code: 'ERR_RAW_SIGNATURES_THIS_EPOCH' })}>
        Toast error
      </Button>
      <Button variant="quiet" size="sm" onClick={() => toast.show({ tone: 'pending', title: 'Waiting for finality' })}>
        Toast pending
      </Button>
    </div>
  );
}

export function FormDemo() {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Field label="Ask" htmlFor="ask" hint="Micro-USDC are rounded down.">
        <Input id="ask" mono suffix="USDC" placeholder="1200.00" inputMode="decimal" />
      </Field>
      <Field label="Account" htmlFor="acct" error="Not a valid NEAR account id." >
        <Input id="acct" mono invalid defaultValue="Bad Account" aria-describedby="acct-error" />
      </Field>
      <Field label="Service" htmlFor="svc">
        <Select id="svc" defaultValue="summarize">
          <option value="summarize">Summarize</option>
          <option value="translate">Translate</option>
        </Select>
      </Field>
      <Field label="Memo" htmlFor="memo" optional>
        <Textarea id="memo" placeholder="Up to 256 bytes" />
      </Field>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 20 }}>
        <Button arrow busy={busy} busyLabel="Signing" onClick={() => setBusy((b) => !b)}>
          List company
        </Button>
        <Button variant="quiet" onClick={() => setBusy(false)}>
          Unlist
        </Button>
        <Button variant="secondary">Cancel</Button>
        <Button disabled>Disabled</Button>
      </div>
    </div>
  );
}

export function TabsDemo() {
  return (
    <Tabs
      label="Desk"
      tabs={[
        { id: 'borrow', label: 'Borrow', badge: 3, content: <p style={{ color: '#adadad' }}>Borrow panel.</p> },
        { id: 'sell', label: 'Sell', content: <p style={{ color: '#adadad' }}>Sell panel.</p> },
        { id: 'repay', label: 'Repay', content: <p style={{ color: '#adadad' }}>Repay panel.</p> },
      ]}
    />
  );
}
