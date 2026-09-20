import { FileText, LayoutDashboard, MailPlus, Plug, Search, SendHorizontal, Users, type LucideIcon } from 'lucide-react';

export interface DashboardNavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

export const DASHBOARD_NAV_ITEMS: DashboardNavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/resume', label: 'Resume', icon: FileText },
  { href: '/dashboard/jobs', label: 'Jobs', icon: Search },
  { href: '/dashboard/applications', label: 'Applications', icon: SendHorizontal },
  { href: '/dashboard/referrals', label: 'Referrals', icon: Users },
  { href: '/dashboard/messages', label: 'Messages', icon: MailPlus },
  { href: '/dashboard/connectors', label: 'Connectors', icon: Plug },
];
