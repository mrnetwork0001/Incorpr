import { Easing, interpolate, spring } from "remotion";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
export const expo = Easing.bezier(0.16, 1, 0.3, 1);
export const soft = Easing.bezier(0.22, 0.7, 0.25, 1);

/** 0 -> 1 between frames a and b, eased. */
export const ramp = (f: number, a: number, b: number, ease = expo) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
/** In over [a, a+inDur], out over [b-outDur, b]. */
export const window = (f: number, a: number, b: number, inDur = 12, outDur = 12) =>
  interpolate(f, [a, a + inDur, b - outDur, b], [0, 1, 1, 0], clamp);
export const pop = (f: number, at: number, fps = 30) => spring({ frame: f - at, fps, config: { damping: 14, stiffness: 170, mass: 0.7 } });
