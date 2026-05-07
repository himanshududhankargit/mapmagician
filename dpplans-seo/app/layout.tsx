import type { Metadata, Viewport } from 'next';
import { SITE } from '@/lib/site';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE.origin),
  title: {
    default: `${SITE.name} — Development Plan maps for India`,
    template: `%s | ${SITE.name}`,
  },
  description: SITE.description,
  applicationName: SITE.name,
  authors: [{ name: 'Map Magician' }],
  creator: 'Map Magician',
  publisher: 'Map Magician',
  formatDetection: { telephone: false },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true } },
  openGraph: {
    type: 'website',
    siteName: SITE.name,
    locale: 'en_IN',
    url: SITE.origin,
    title: `${SITE.name} — Development Plan maps for India`,
    description: SITE.description,
  },
  twitter: { card: 'summary_large_image', site: SITE.twitter },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f4c81',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SiteHeader />
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
