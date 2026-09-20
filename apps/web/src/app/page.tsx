import { CompanyMarquee } from '@/components/marketing/CompanyMarquee';
import { CtaSection } from '@/components/marketing/CtaSection';
import { DemoPreview } from '@/components/marketing/DemoPreview';
import { FeatureGrid } from '@/components/marketing/FeatureGrid';
import { FloatingOrbs } from '@/components/marketing/FloatingOrbs';
import { Footer } from '@/components/marketing/Footer';
import { Hero } from '@/components/marketing/Hero';
import { HowItWorks } from '@/components/marketing/HowItWorks';
import { NavBar } from '@/components/marketing/NavBar';
import { Outcomes } from '@/components/marketing/Outcomes';
import { PipelineDock } from '@/components/marketing/PipelineDock';
import { StatsSection } from '@/components/marketing/StatsSection';

export default function HomePage() {
  return (
    <main className="relative">
      <FloatingOrbs />
      <NavBar />
      <Hero />
      <StatsSection />
      <DemoPreview />
      <CompanyMarquee />
      <FeatureGrid />
      <HowItWorks />
      <Outcomes />
      <CtaSection />
      <Footer />
      <PipelineDock />
    </main>
  );
}
