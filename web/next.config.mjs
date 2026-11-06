import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(fileURLToPath(import.meta.url));

// Files outside web/ that server code reads at runtime: /verify reads the contract sources, the built
// wasm and ABI, and the evidence log; /rob and its API read the evidence log. On a host that deploys
// only the traced files (Vercel), they must be listed here or those pages lose their evidence.
const REPO_EVIDENCE = ['../docs/evidence/*.json'];
const REPO_SOURCES = [
  '../contracts/res/*.wasm',
  '../contracts/res/*_abi.json',
  '../contracts/integration-tests/tests/*.rs',
  '../contracts/company-vault/src/*.rs',
  '../contracts/incorpr-registry/src/*.rs',
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A separate build directory lets `next build` run while `next dev` uses .next (NEXT_DIST_DIR=.next-build).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The Next 14 image optimizer has unpatched RCE advisories (GHSA-2xp9-vwfh-vxw4,
  // GHSA-2464-fhr4-w9xw). This app renders on-chain SVG data URIs and never uses it.
  // With this set, next-server answers 404 on /_next/image before reaching the optimizer.
  images: { unoptimized: true },
  experimental: {
    serverComponentsExternalPackages: ['@phala/dcap-qvl'],
    // Trace from the repository root so files in ../docs and ../contracts can be included.
    outputFileTracingRoot: path.join(webDir, '..'),
    outputFileTracingIncludes: {
      '/verify': [...REPO_SOURCES, ...REPO_EVIDENCE],
      '/rob': REPO_EVIDENCE,
      '/api/rob/**/*': REPO_EVIDENCE,
    },
  },
};

export default nextConfig;
