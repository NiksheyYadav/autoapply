import { Footer } from '@/components/marketing/Footer';
import { NavBar } from '@/components/marketing/NavBar';

export const metadata = {
  title: 'Privacy Policy — Atlas',
  description: 'What Atlas collects, why, and how to request it be deleted.',
};

export default function PrivacyPage() {
  return (
    <main className="relative">
      <NavBar />
      <div className="mx-auto max-w-3xl px-6 py-24">
        <p className="mb-3 font-[var(--font-mono)] text-xs uppercase tracking-[0.18em] text-[var(--color-accent)]">
          Last updated September 2026
        </p>
        <h1 className="mb-10 font-[var(--font-display)] text-4xl font-medium text-[var(--color-ink)] md:text-5xl">
          Privacy Policy
        </h1>

        <div className="flex flex-col gap-10 text-[var(--color-ink-soft)]">
          <section>
            <p className="leading-relaxed">
              Atlas is an early-stage product, currently in beta. This policy describes what we collect today and why —
              it will be revised as the product grows, and we&apos;ll date every change at the top of this page.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-medium text-[var(--color-ink)]">What we collect</h2>
            <ul className="flex flex-col gap-2 leading-relaxed">
              <li>
                <strong className="text-[var(--color-ink)]">Account information</strong> — your name and email address,
                either entered directly or provided by Google/Microsoft when you sign in with one of those.
              </li>
              <li>
                <strong className="text-[var(--color-ink)]">Resume and profile data</strong> — resumes you upload, and the
                skills, experience, and contact details Atlas parses out of them to power job matching.
              </li>
              <li>
                <strong className="text-[var(--color-ink)]">Job search activity</strong> — jobs you view or apply to,
                applications you submit through Atlas, and referral contacts Atlas surfaces for you.
              </li>
              <li>
                <strong className="text-[var(--color-ink)]">Basic usage data</strong> — which features you use, so we can
                tell what&apos;s working and what to fix next.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-medium text-[var(--color-ink)]">What we don&apos;t do</h2>
            <p className="leading-relaxed">
              We don&apos;t sell your data. We don&apos;t share your resume or job-search activity with employers or
              third parties except the specific job boards and referral contacts you choose to act on through the
              product.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Who processes it</h2>
            <p className="leading-relaxed">
              Authentication and our database run on{' '}
              <a
                href="https://supabase.com/privacy"
                className="text-[var(--color-accent)] underline underline-offset-2"
                target="_blank"
                rel="noreferrer"
              >
                Supabase
              </a>
              . If you sign in with Google or Microsoft, those providers process your sign-in per their own privacy
              policies. The site itself is hosted on{' '}
              <a
                href="https://vercel.com/legal/privacy-policy"
                className="text-[var(--color-accent)] underline underline-offset-2"
                target="_blank"
                rel="noreferrer"
              >
                Vercel
              </a>
              .
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Your data, your call</h2>
            <p className="leading-relaxed">
              You can delete your uploaded resumes and profile data from your dashboard at any time. To delete your
              account entirely, contact us at the address below and we&apos;ll remove your account and associated data.
            </p>
          </section>

          <section>
            <h2 className="mb-3 text-xl font-medium text-[var(--color-ink)]">Contact</h2>
            <p className="leading-relaxed">
              Questions about this policy or your data:{' '}
              <a href="mailto:relativity1905e@gmail.com" className="text-[var(--color-accent)] underline underline-offset-2">
                relativity1905e@gmail.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
      <Footer />
    </main>
  );
}
