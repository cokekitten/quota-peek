import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quota Peek',
  description: 'AI coding plan usage — Claude Code, Codex, GLM',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Set the saved theme before first paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('qp-theme');document.documentElement.dataset.theme=t==='c'?'c':'a'}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
