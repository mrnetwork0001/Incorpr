import React from "react";
import { Composition, Still, type CalculateMetadataFunction } from "remotion";
import { Film } from "./Film";
import { Poster } from "./Poster";
import { Banner } from "./Banner";
import { T } from "./timing";
import { EMPTY, exists, loadEvidence, type FilmProps } from "./evidence";

/** Reads docs/evidence (copied to public/ by scripts/sync.mjs) and checks the hero images at render time. */
const load: CalculateMetadataFunction<FilmProps> = async ({ props }) => {
  const network = typeof props.network === "string" ? props.network : undefined;
  const [evidence, hands] = await Promise.all([loadEvidence(network), exists("hero/hand-left.png")]);
  return { props: { ...props, evidence, assets: { hands } } };
};

export const Root: React.FC = () => (
  <>
    <Composition id="Incorpr" component={Film} durationInFrames={T.totalFrames} fps={T.fps} width={1920} height={1080} defaultProps={EMPTY} calculateMetadata={load} />
    <Still id="Poster" component={Poster} width={1280} height={720} defaultProps={EMPTY} calculateMetadata={load} />
    <Still id="Banner" component={Banner} width={1500} height={500} defaultProps={EMPTY} calculateMetadata={load} />
  </>
);
