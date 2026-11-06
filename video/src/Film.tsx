import React from "react";
import { AbsoluteFill, Audio, Freeze, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { T, scene, wordAtOr } from "./timing";
import { C } from "./theme";
import { EvidenceCtx, type FilmProps } from "./evidence";
import { Captions } from "./ui/Captions";
import { Chrome } from "./ui/Chrome";
import { Grain } from "./ui/Grain";
import { clamp } from "./ui/motion";
import { Hook } from "./scenes/Hook";
import { Incorporate } from "./scenes/Incorporate";
import { Earn } from "./scenes/Earn";
import { Rob } from "./scenes/Rob";
import { Sell } from "./scenes/Sell";
import { Borrow } from "./scenes/Borrow";
import { Close } from "./scenes/Close";

const SCENES: Record<string, React.FC> = { hook: Hook, incorporate: Incorporate, earn: Earn, rob: Rob, sell: Sell, borrow: Borrow, close: Close };
const OVERLAP = 12; // frames each scene starts early, to dissolve over the last

/** Each scene eases in (a short rise, un-blur and settle) over the tail of the previous one, holding its first frame. */
const SceneIn: React.FC<{ S: React.FC; first: boolean }> = ({ S, first }) => {
  const f = useCurrentFrame();
  if (first) return <S />;
  const p = interpolate(f, [0, OVERLAP], [0, 1], { ...clamp, easing: (t) => 1 - Math.pow(1 - t, 3) });
  const body = f < OVERLAP ? <Freeze frame={0}><S /></Freeze> : <Sequence from={OVERLAP} layout="none"><S /></Sequence>;
  return <AbsoluteFill style={{ opacity: p, transform: `scale(${1.03 - 0.03 * p})`, filter: p < 1 ? `blur(${(1 - p) * 10}px)` : undefined }}>{body}</AbsoluteFill>;
};

// --- Music, ducked under every spoken line.
const LINES = T.scenes.flatMap((s) => s.lines.map((l) => [l.startFrame, l.words[l.words.length - 1].end] as const));
const DUCK: number[] = (() => {
  const v = new Array<number>(T.totalFrames + 1).fill(0);
  for (let f = 0; f <= T.totalFrames; f++) {
    let d = 0;
    for (const [a, b] of LINES) d = Math.max(d, interpolate(f, [a - 10, a, b, b + 14], [0, 1, 1, 0], clamp));
    v[f] = d;
  }
  return v;
})();
const musicVolume = (f: number) => {
  const end = T.totalFrames;
  const fadeIn = interpolate(f, [0, 20], [0, 1], clamp);
  const fadeOut = interpolate(f, [end - 50, end], [1, 0], clamp);
  return (0.55 - 0.38 * DUCK[Math.min(end, Math.max(0, f))]) * fadeIn * fadeOut;
};

interface Fx { file: string; at: number; vol: number; dur?: number }
/** Effects on spoken words. Only files that exist (timing.json `sfx`, from public/audio/sfx) are placed. */
function effects(): Fx[] {
  const sc = (id: string) => scene(id).from;
  const w = (id: string, word: string, local: number) => wordAtOr(id, word, sc(id) + local);
  const fx: Fx[] = [
    { file: "tick", at: 6, vol: 0.3 },
    { file: "link", at: w("hook", "transfer.", 40) - 2, vol: 0.45 },
    { file: "whoosh", at: sc("incorporate") - 8, vol: 0.3 },
    { file: "lock", at: w("incorporate", "key.", 110) - 2, vol: 0.4 },
    ...["Bitcoin,", "Solana", "EVM"].map((x, i) => ({ file: "tick", at: w("incorporate", x, 200 + i * 15) - 2, vol: 0.4 })),
    { file: "whoosh", at: sc("earn") - 8, vol: 0.3 },
    { file: "coin", at: w("earn", "pay", 20) + 4, vol: 0.35 },
    { file: "chime", at: w("earn", "verifies", 300) + 2, vol: 0.35 },
    { file: "riser", at: sc("rob") - 70, vol: 0.3 },
    { file: "typing", at: w("rob", "ask", 70), vol: 0.22 },
    { file: "denied", at: w("rob", "not.", 210) - 2, vol: 0.5 },
    { file: "stamp", at: w("rob", "not.", 210) + 6, vol: 0.55 },
    { file: "whoosh", at: sc("sell") - 8, vol: 0.3 },
    { file: "click", at: w("sell", "lists", 40), vol: 0.4 },
    { file: "link", at: w("sell", "one", 190) - 2, vol: 0.45 },
    { file: "whoosh", at: sc("borrow") - 8, vol: 0.3 },
    { file: "lock", at: w("borrow", "frozen", 140) - 2, vol: 0.45 },
    { file: "whoosh", at: sc("close") - 8, vol: 0.3 },
    { file: "chime", at: w("close", "Incorpr,", 90) - 2, vol: 0.4 },
  ];
  const have = new Set(T.sfx ?? []);
  return fx.filter((x) => have.has(x.file) && x.at >= 0 && x.at < T.totalFrames);
}

/**
 * The film. Before any footage is captured every scene is a title card in the site's design; once
 * scripts/encode.mjs writes a clip to src/footage.json, the scenes that name it play it instead.
 * Audio plays only for files that exist (timing.json records which), so the film renders without audio.
 */
export const Film: React.FC<FilmProps> = (props) => {
  // Captions sit out where big type already carries the words.
  const hideCaptions = (f: number) => {
    const s = T.scenes.find((x) => f >= x.from && f < x.from + x.durationInFrames);
    return !s || ["hook", "close"].includes(s.id);
  };
  return (
    <EvidenceCtx.Provider value={props}>
      <AbsoluteFill style={{ background: C.bg }}>
        {T.scenes.map((s, i) => {
          const S = SCENES[s.id];
          const from = i === 0 ? s.from : s.from - OVERLAP;
          const dur = s.durationInFrames + (i === 0 ? 0 : OVERLAP);
          return S ? (
            <Sequence key={s.id} from={from} durationInFrames={dur} name={s.id}>
              <SceneIn S={S} first={i === 0} />
            </Sequence>
          ) : null;
        })}
        <Grain opacity={0.07} />
        <Chrome />
        <Captions hidden={hideCaptions} />
        {T.music ? <Audio src={staticFile(T.music.file)} volume={musicVolume} /> : null}
        {T.scenes.flatMap((s) => s.lines).filter((l) => l.audio).map((l, i) => (
          <Sequence key={`vo${i}`} from={l.startFrame} durationInFrames={l.durationFrames} name={`vo ${l.text.slice(0, 18)}`}>
            <Audio src={staticFile(l.file)} volume={1} />
          </Sequence>
        ))}
        {effects().map((x, i) => (
          <Sequence key={`fx${i}`} from={x.at} durationInFrames={x.dur ?? 150} name={`fx ${x.file}`}>
            <Audio src={staticFile(`audio/sfx/${x.file}.mp3`)} volume={(f) => x.vol * (x.dur ? interpolate(f, [0, 8, x.dur - 20, x.dur], [0, 1, 1, 0], clamp) : 1)} />
          </Sequence>
        ))}
      </AbsoluteFill>
    </EvidenceCtx.Provider>
  );
};
