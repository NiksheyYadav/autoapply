import { Compass } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-[var(--color-line)] px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm text-[var(--color-ink-faint)] md:flex-row">
        <span className="flex items-center gap-2">
          <Compass className="h-4 w-4" />
          Atlas
        </span>
        <span>Built incrementally, one honest workflow at a time.</span>
      </div>
    </footer>
  );
}
