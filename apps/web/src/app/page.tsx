import type { Metadata } from 'next';
import { CtaSection } from '@/components/marketing/CtaSection';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { FloatingOrbs } from '@/components/marketing/FloatingOrbs';
import { Footer } from '@/components/marketing/Footer';
import { Hero } from '@/components/marketing/Hero';
import { HowItWorks } from '@/components/marketing/HowItWorks';
import { NavBar } from '@/components/marketing/NavBar';
import { Outcomes } from '@/components/marketing/Outcomes';
import { PipelineDock } from '@/components/marketing/PipelineDock';
import { StatsSection } from '@/components/marketing/StatsSection';

// The one page that should be indexed: it carries the canonical URL, and
// openGraph.url, which the root layout deliberately leaves unset so other
// routes don't inherit it.
export const metadata: Metadata = {
  alternates: { canonical: '/' },
  openGraph: { url: '/' },
};

export default function HomePage() {
  return (
    <main className="relative">
      <FloatingOrbs />
      <NavBar />
      <Hero />
      <StatsSection />
      <FeatureGrid />
      <HowItWorks />
      <Outcomes />
      <CtaSection />
      <Footer />
      <PipelineDock />
    </main>
  );
}
