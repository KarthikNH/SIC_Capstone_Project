import React from 'react';
import { HeroScene } from './HeroScene';

export const Hero: React.FC = () => {
  return (
    <header className="relative h-[min(78vh,620px)] min-h-[440px] bg-[#232629] overflow-hidden flex items-center justify-center text-center">
      {/* 3D Rotating Grid Canvas */}
      <HeroScene />

      {/* Subtle vignette overlay */}
      <div className="absolute inset-0 bg-[#141619]/45 pointer-events-none" />

      {/* Hero Content */}
      <div className="relative z-10 text-white px-6 max-w-[720px] mx-auto mt-12">
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-semibold leading-[1.1] mb-5 tracking-tight">
          Spot a cascading failure before it spreads
        </h1>
        <p className="text-[15px] sm:text-base text-white/85 max-w-[540px] mx-auto mb-8 font-normal leading-relaxed">
          A graph neural network reads the grid right after an outage and warns operators if it is likely to turn into a blackout.
        </p>
        <a href="#demo" className="btn-estate inline-block">
          See it in action
        </a>
      </div>
    </header>
  );
};
