/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Next 14 image optimizer has unpatched RCE advisories (GHSA-2xp9-vwfh-vxw4,
  // GHSA-2464-fhr4-w9xw). This app renders on-chain SVG data URIs and never uses it.
  // With this set, next-server answers 404 on /_next/image before reaching the optimizer.
  images: { unoptimized: true },
  experimental: {
    serverComponentsExternalPackages: ['@phala/dcap-qvl'],
  },
};

export default nextConfig;
