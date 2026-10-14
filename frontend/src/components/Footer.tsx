import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer className="bg-charcoal text-white mt-32 pt-14 pb-8">
      <div className="max-w-[1000px] mx-auto px-6">
        <div className="flex flex-wrap gap-12 sm:gap-16 justify-between">
          <div className="mr-auto">
            <a href="#" className="font-serif font-bold text-3xl tracking-tight text-white hover:opacity-90">
              Gridwatch
            </a>
            <p className="text-xs text-white/60 mt-2 max-w-[260px] font-sans">
              Graph-based early warning system for cascading failures in power grids.
            </p>
          </div>

          <div>
            <ul className="space-y-2.5 text-[13px] font-medium text-white/85">
              <li><a href="#" className="hover:text-white transition-colors">Home</a></li>
              <li><a href="#demo" className="hover:text-white transition-colors">Live demo</a></li>
              <li><a href="#how" className="hover:text-white transition-colors">How it works</a></li>
              <li><a href="#results" className="hover:text-white transition-colors">Results</a></li>
            </ul>
          </div>

          <div>
            <ul className="space-y-2.5 text-[13px] font-medium text-white/85">
              <li><a href="/docs" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">OpenAPI Docs</a></li>
              <li><a href="#demo" className="hover:text-white transition-colors">Source code</a></li>
              <li><a href="#demo" className="hover:text-white transition-colors">IEEE Dataset</a></li>
            </ul>
          </div>

          <div>
            <ul className="space-y-2.5 text-[13px] font-medium text-white/85">
              <li><span className="text-white/60 cursor-default">Terms of service</span></li>
              <li><span className="text-white/60 cursor-default">Privacy policy</span></li>
            </ul>
          </div>
        </div>

        <hr className="border-0 border-t border-[#444] my-10 mb-6" />

        <small className="block text-center text-xs font-medium text-white/65">
          Copyright @ 2026 Gridwatch • Powered by Graph Isomorphism Networks
        </small>
      </div>
    </footer>
  );
};
