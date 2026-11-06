import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

/** Fine moving film grain over the whole frame, very low opacity. */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.06 }) => {
  const f = useCurrentFrame();
  const seed = (f % 8) + 1;
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
      <svg width="100%" height="100%">
        <filter id={`g${seed}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#g${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};
