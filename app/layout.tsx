import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quota Peek',
  description: 'AI coding plan usage — Claude Code, Codex, GLM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
