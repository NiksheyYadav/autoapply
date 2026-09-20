import { CompanyMarquee } from '@/components/marketing/CompanyMarquee';
import { CtaSection } from '@/components/marketing/CtaSection';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { Footer } from '@/components/marketing/Footer';
import { Hero } from '@/components/marketing/Hero';
import { HowItWorks } from '@/components/marketing/HowItWorks';
import { NavBar } from '@/components/marketing/NavBar';
import { Outcomes } from '@/components/marketing/Outcomes';
import { StatsSection } from '@/components/marketing/StatsSection';

export default function HomePage() {
  return (
    <main>
      <NavBar />
      <Hero />
      <StatsSection />
      <CompanyMarquee />
      <FeatureGrid />
      <HowItWorks />
      <Outcomes />
      <CtaSection />
      <Footer />
    </main>
  );
}
