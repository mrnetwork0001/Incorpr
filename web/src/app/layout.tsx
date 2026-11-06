import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans, Newsreader } from 'next/font/google';
import type { ReactNode } from 'react';
import { WalletProvider } from '@/lib/wallet';
import './globals.css';

const display = Newsreader({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-sans', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Incorpr: companies as NEP-171 NFTs on NEAR',
  description:
    'Each token is an AI service with its own NEAR sub-account, USDC revenue ledger, and Bitcoin, Solana and EVM addresses. Borrow against it or sell it by transferring one NFT.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <head>
        {/* Google Sans Flex is not in the next/font catalog of Next 14, so it loads from Google Fonts directly. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- app router root layout applies to every page */}
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans+Flex:opsz,wght@6..144,100..900&display=swap" />
      </head>
      <body className="min-h-screen bg-ink font-sans text-paper antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
