import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { T } from "../timing";
import { C, mono, SCENE_LABEL } from "../theme";
import { useFilm } from "../evidence";
import { clamp } from "./motion";

/** Corner furniture: the wordmark and scene tag, the network, the event and the evidence source. */
export const Chrome: React.FC<{ hideAfter?: number }> = ({ hideAfter }) => {
  const f = useCurrentFrame();
  const { evidence } = useFilm();
  const sc = T.scenes.find((s) => f >= s.from && f < s.from + s.durationInFrames) ?? T.scenes[T.scenes.length - 1];
  const tagIn = interpolate(f - sc.from, [4, 16], [0, 1], clamp);
  const op = hideAfter != null ? interpolate(f, [hideAfter, hideAfter + 12], [1, 0], clamp) : 1;
  const base: React.CSSProperties = { position: "absolute", fontFamily: mono, fontSize: 15, letterSpacing: "0.08em", color: C.grey2, opacity: op, textTransform: "uppercase" };
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div style={{ ...base, left: 56, top: 40 }}>
        <span style={{ color: C.amber }}>incorpr</span>
        <span style={{ marginLeft: 18, opacity: tagIn }}>{SCENE_LABEL[sc.id]}</span>
      </div>
      {/* The network is named only when an evidence file says which one; no file, no claim. */}
      <div style={{ ...base, right: 56, top: 40 }}>{evidence ? `near ${evidence.network}` : "near"}</div>
      <div style={{ ...base, left: 56, bottom: 36, fontSize: 13 }}>near hackathon · nov 2026</div>
      <div style={{ ...base, right: 56, bottom: 36, fontSize: 13, textTransform: "none" }}>
        {evidence ? `hashes: ${evidence.source}` : "no evidence file: hashes hidden"}
      </div>
    </AbsoluteFill>
  );
};
