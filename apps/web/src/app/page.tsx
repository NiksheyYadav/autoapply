import { CtaSection } from '@/components/marketing/CtaSection.js';
import { FeatureGrid } from '@/components/marketing/FeatureGrid.js';
import { Footer } from '@/components/marketing/Footer.js';
import { Hero } from '@/components/marketing/Hero.js';
import { HowItWorks } from '@/components/marketing/HowItWorks.js';
import { NavBar } from '@/components/marketing/NavBar.js';
import { StatsSection } from '@/components/marketing/StatsSection.js';

export default function HomePage() {
  return (
    <main>
      <NavBar />
      <Hero />
      <StatsSection />
      <FeatureGrid />
      <HowItWorks />
      <CtaSection />
      <Footer />
    </main>
  );
}
