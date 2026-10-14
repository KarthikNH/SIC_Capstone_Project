import React from 'react';

export const About: React.FC = () => {
  return (
    <section className="pt-24 sm:pt-28">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr] gap-8 md:gap-12">
        <p className="eyebrow">About</p>
        <div>
          <h2 className="text-2xl sm:text-[26px] font-semibold leading-[1.3] text-ink mb-3.5">
            One early signal, before the problem grows
          </h2>
          <p className="text-[15px] leading-relaxed text-[#555] max-w-[560px]">
            The grid is treated as a graph: buses are points and transmission lines connect them. Using only the state right after a disturbance, the model predicts whether the outage will cascade, and shows which lines drive that prediction.
          </p>
        </div>
      </div>
    </section>
  );
};
