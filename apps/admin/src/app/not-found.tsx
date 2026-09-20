import { Logo, RadarSweep } from '@atlas/ui';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-24 text-center">
      <Link href="/" className="mb-10">
        <Logo />
      </Link>
      <RadarSweep size={200} className="mx-auto mb-8" />
      <h1 className="max-w-md font-[var(--font-display)] text-2xl font-medium text-[var(--color-ink)]">
        This route isn&apos;t on the map
      </h1>
      <p className="mt-3 max-w-sm text-[var(--color-ink-soft)]">
        Whatever you were looking for, it isn&apos;t here.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex h-11 items-center rounded-full border border-[var(--color-line)] bg-white/5 px-5 text-sm font-medium text-[var(--color-ink)] transition-colors hover:border-[var(--color-line-strong)]"
      >
        Back to Atlas Admin
      </Link>
    </div>
  );
}
