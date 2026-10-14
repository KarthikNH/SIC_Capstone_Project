import React from 'react';

export const HowItWorks: React.FC = () => {
  return (
    <section id="how" className="pt-24 sm:pt-28">
      <p className="eyebrow mb-7">How it works</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
        <div>
          <b className="block font-serif text-3xl font-semibold text-label">1</b>
          <h3 className="text-base font-semibold text-ink mt-2 mb-1.5">
            An outage happens
          </h3>
          <p className="text-sm text-[#666] leading-relaxed">
            A line or generator drops out and the grid settles into a new state.
          </p>
        </div>

        <div>
          <b className="block font-serif text-3xl font-semibold text-label">2</b>
          <h3 className="text-base font-semibold text-ink mt-2 mb-1.5">
            The model reads the grid
          </h3>
          <p className="text-sm text-[#666] leading-relaxed">
            It looks at every bus and line in that first state, before anything else fails.
          </p>
        </div>

        <div>
          <b className="block font-serif text-3xl font-semibold text-label">3</b>
          <h3 className="text-base font-semibold text-ink mt-2 mb-1.5">
            You get a warning
          </h3>
          <p className="text-sm text-[#666] leading-relaxed">
            A risk level and the lines that matter most, ready for an operator to check.
          </p>
        </div>
      </div>
    </section>
  );
};
