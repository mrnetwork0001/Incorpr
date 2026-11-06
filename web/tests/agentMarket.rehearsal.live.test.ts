// Live rehearsal of the Agent Market deliverable: one real NEAR AI Cloud chat completion, its real
// TEE signature, and a fresh attestation report, over a small Solidity brief. Reads the company
// (name, service_template, vault) from the configured registry. Sends no transaction and calls no
// Agent Market endpoint.
//
// Spends one inference call, so it runs only when asked:
//   cd web && set -a && . ./.env.local && set +a && AGENT_MARKET_REHEARSAL=1 npx vitest run tests/agentMarket.rehearsal.live.test.ts
// AGENT_MARKET_REHEARSAL_OUT=<path> also writes the Markdown there.

import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDeliverable, readCompany, realTee, REQUIRED_CHECKS } from '@/lib/agentMarketWork';
import { recoverEip191Address } from '@/lib/nearAiTee';

const enabled = process.env.AGENT_MARKET_REHEARSAL === '1' && Boolean(process.env.NEAR_AI_API_KEY);

const SNIPPET = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TipJar {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balances[msg.sender] >= amount, "low");
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
        balances[msg.sender] -= amount;
    }
}`;

describe.runIf(enabled)('Agent Market deliverable, live NEAR AI Cloud', () => {
  it('runs the company skill, verifies the TEE signature and renders a checkable deliverable', async () => {
    const company = await readCompany(process.env.AGENT_MARKET_COMPANY_ID || '1');
    const deliverable = await buildDeliverable({
      company,
      input: {
        title: 'Audit TipJar.withdraw',
        description: `Please audit this contract before I deploy it.\n\n${SNIPPET}`,
        tags: ['solidity', 'audit'],
        attachments: [],
        round: 'fresh',
        feedback: null,
        previousAudit: null,
      },
      tee: realTee,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL || null,
    });

    console.log(`\n${'='.repeat(30)} deliverable markdown ${'='.repeat(30)}\n${deliverable.markdown}\n${'='.repeat(82)}`);
    if (process.env.AGENT_MARKET_REHEARSAL_OUT) writeFileSync(process.env.AGENT_MARKET_REHEARSAL_OUT, deliverable.markdown);

    for (const check of REQUIRED_CHECKS) expect(deliverable.summary.passed, check).toContain(check);
    expect(deliverable.summary.failed).toEqual([]);
    expect(deliverable.markdown).toContain('## Verify this answer');
    expect(deliverable.markdown).toContain(`Delivered by ${company.name}, NEP-171 company #${company.tokenId} on NEAR (vault ${company.vault}).`);
    const signedText = /\| Signed text \| `([^`]+)` \|/.exec(deliverable.markdown)![1]!;
    const signature = /\| Signature \(EIP-191, ECDSA secp256k1\) \| `([^`]+)` \|/.exec(deliverable.markdown)![1]!;
    expect(recoverEip191Address(signedText, signature)).toBe(deliverable.signingAddress);
  });
});
