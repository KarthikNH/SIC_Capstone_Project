import React, { useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { Hero } from './components/Hero';
import { About } from './components/About';
import { LiveDemo } from './components/LiveDemo';
import { HowItWorks } from './components/HowItWorks';
import { ResultsSection } from './components/ResultsSection';
import { Footer } from './components/Footer';
import { useGridStore } from './store';

export const App: React.FC = () => {
  const { fetchGridAndLayout } = useGridStore();

  useEffect(() => {
    fetchGridAndLayout();
  }, [fetchGridAndLayout]);

  return (
    <div className="min-h-screen bg-white text-ink flex flex-col font-sans">
      {/* Top Navbar */}
      <Navbar />

      {/* Hero with rotating 3D network behind title */}
      <Hero />

      {/* Main Single Scroll Container */}
      <main className="max-w-[1000px] w-full mx-auto px-6 flex-1">
        <About />
        <LiveDemo />
        <HowItWorks />
        <ResultsSection />
      </main>

      {/* Dark Charcoal Footer */}
      <Footer />
    </div>
  );
};

export default App;
