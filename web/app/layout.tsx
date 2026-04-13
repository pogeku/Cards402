import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { MarketingChrome } from '@/app/components/MarketingChrome';
import './globals.css';

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: 'cards402 — Virtual cards for AI agents',
  description:
    'Pay USDC or XLM on Stellar. Get a Visa card number in ~60 seconds. No signup. No KYC. No fees.',
  openGraph: {
    title: 'cards402 — Virtual cards for AI agents',
    description: 'Pay USDC or XLM on Stellar. Get a Visa card number in ~60 seconds.',
    url: 'https://cards402.com',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body
        style={{
          background: 'var(--bg)',
          color: 'var(--fg)',
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          margin: 0,
        }}
      >
        <MarketingChrome>{children}</MarketingChrome>
      </body>
    </html>
  );
}
