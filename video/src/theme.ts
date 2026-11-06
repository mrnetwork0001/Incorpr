import { loadFont as loadFlex } from "@remotion/google-fonts/GoogleSansFlex";
import { loadFont as loadMono } from "@remotion/google-fonts/IBMPlexMono";

/** The site's families (web/src/app/layout.tsx): Google Sans Flex for headlines and UI, IBM Plex Mono for data. */
export const sans = loadFlex("normal", { weights: ["300", "400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

/** Incorpr's palette, from web/src/app/hero/hero.module.css. */
export const C = {
  bg: "#0d0d0d",
  ink: "#ffffff",
  grey1: "#adadad",
  grey2: "#7d7d7d",
  grey3: "#717171",
  amber: "#f0a24c",
  amberSoft: "#e0a165",
  wordmark: "#5a3418",
  pillBg: "#1d1510",
  pillInk: "#e9d3bb",
  panel: "rgba(22,19,16,0.82)",
  line: "rgba(255,255,255,0.10)",
  danger: "#ff6b5e",
  ok: "#8fd6a1",
};

/** Glass panel with the glowing amber top edge. */
export const glass = (glow = 1): React.CSSProperties => ({
  background: "linear-gradient(180deg, rgba(34,28,22,0.86) 0%, rgba(17,15,13,0.9) 100%)",
  borderRadius: 22,
  boxShadow: [
    `inset 0 1px 0 rgba(240,162,76,${0.75 * glow})`,
    "inset 0 0 0 1px rgba(255,255,255,0.07)",
    `0 -1px 24px -6px rgba(240,162,76,${0.55 * glow})`,
    "0 40px 90px rgba(0,0,0,0.55)",
  ].join(", "),
  backdropFilter: "blur(16px)",
});

/** Glossy amber-glass button body (the site's .cta). */
export const amberButton: React.CSSProperties = {
  background: "linear-gradient(180deg, #2c241d 0%, #4a3826 45%, #7a5832 100%)",
  borderRadius: 999,
  boxShadow: [
    "inset 0 1px 0 rgba(255,255,255,0.6)",
    "inset 0 -1px 0 rgba(240,162,76,0.85)",
    "inset 0 0 0 1px rgba(240,162,76,0.35)",
    "inset 0 -10px 18px -10px rgba(240,162,76,0.55)",
    "0 0 0 1px rgba(0,0,0,0.6)",
    "0 12px 34px -8px rgba(240,162,76,0.6)",
  ].join(", "),
  color: "#fff",
};

/** The site's background: near-black with two warm amber glows. */
export const BG = `radial-gradient(60% 55% at 78% 32%, rgba(240,162,76,0.13), transparent 70%), radial-gradient(40% 30% at 50% 100%, rgba(240,162,76,0.10), transparent 70%), ${C.bg}`;

/** Corner tags. */
export const SCENE_LABEL: Record<string, string> = {
  hook: "01 · one transfer",
  incorporate: "02 · incorporate",
  earn: "03 · earn",
  rob: "04 · rob this company",
  sell: "05 · sell",
  borrow: "06 · borrow",
  close: "07 · verify",
};
