import { Logo } from '@atlas/ui';

export function Footer() {
  return (
    <footer className="border-t border-[var(--color-line)] px-6 py-10 md:pb-28">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm text-[var(--color-ink-faint)] md:flex-row">
        <Logo size={20} />
        <span>Built incrementally, one honest workflow at a time.</span>
      </div>
    </footer>
  );
}
