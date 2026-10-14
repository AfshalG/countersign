'use client';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icons';

const TABS: { href: string; label: string; icon: IconName }[] = [
  { href: '/', label: 'Inbox', icon: 'inbox' },
  { href: '/orders', label: 'Suppliers', icon: 'store' },
  { href: '/account', label: 'Account', icon: 'user' },
  { href: '/connect', label: 'Connect', icon: 'plug' },
];

/**
 * The bottom dock, in thumb reach. Hidden on the approval sheet, where the decision owns the
 * bottom of the screen.
 */
export function Dock() {
  const path = usePathname();
  if (path.startsWith('/approve/')) return null;
  return (
    <nav className="dock" aria-label="Main">
      {TABS.map((t) => (
        <a key={t.href} href={t.href} aria-current={path === t.href ? 'page' : undefined}>
          <Icon name={t.icon} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}
