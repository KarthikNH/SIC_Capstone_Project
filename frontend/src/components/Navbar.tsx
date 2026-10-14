import React from 'react';

export const Navbar: React.FC = () => {
  return (
    <nav className="absolute top-0 left-0 right-0 z-20 flex items-center gap-8 py-8 px-6 max-w-[1000px] mx-auto">
      <a href="#" className="font-serif font-bold text-3xl text-white tracking-tight hover:opacity-90 transition-opacity">
        Gridwatch
      </a>
      <div className="hidden sm:flex items-center gap-7 text-[13px] font-medium text-white/90">
        <a href="#" className="border-b border-white pb-0.5 text-white">Home</a>
        <a href="#demo" className="border-b border-transparent pb-0.5 hover:border-white transition-colors">Live demo</a>
        <a href="#how" className="border-b border-transparent pb-0.5 hover:border-white transition-colors">How it works</a>
        <a href="#results" className="border-b border-transparent pb-0.5 hover:border-white transition-colors">Results</a>
      </div>
      <div className="flex-1" />
      <a href="#demo" className="btn-estate">
        Try the demo
      </a>
    </nav>
  );
};
