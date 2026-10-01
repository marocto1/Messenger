import type { Metadata } from 'next';
import './globals.css';
import './release.css';
import { DialogHost } from '../components/ui';

export const metadata: Metadata = {
  title: 'Marocto Messenger',
  description: 'Твоё пространство для общения — сообщения, файлы и звонки.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body><script dangerouslySetInnerHTML={{ __html: "try{document.documentElement.dataset.theme=localStorage.getItem('messenger_theme')||'midnight'}catch{}" }} />{children}<DialogHost /></body>
    </html>
  );
}
