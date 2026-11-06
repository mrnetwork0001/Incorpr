// Fonts for share cards. Satori (next/og) needs TTF or OTF data, not woff2, so the files come from
// the Google Fonts CSS API, which serves TTF to a client that does not send a browser user agent.
// Google Sans Flex is a variable font; the API answers each weight with a static instance, which is
// what Satori can draw. If Google Fonts cannot be reached the card still renders with next/og's
// bundled Noto Sans.

const CSS_URL =
  'https://fonts.googleapis.com/css2?family=Google+Sans+Flex:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap';
const FETCH_TIMEOUT_MS = 5_000;
const RETRY_AFTER_MS = 5 * 60_000;

export interface OgFont {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 500;
  style: 'normal';
}

/** Family name used in card styles. */
export const SANS = 'Google Sans Flex';
export const MONO = 'IBM Plex Mono';

interface FaceRef {
  family: string;
  weight: 400 | 500;
  url: string;
}

/** Reads the @font-face blocks of a Google Fonts CSS response. Exported for tests. */
export function parseFontFaces(css: string): FaceRef[] {
  const faces: FaceRef[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1];
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
    const url = /src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/.exec(block)?.[1];
    if (family && url && (weight === 400 || weight === 500)) faces.push({ family, weight, url });
  }
  return faces;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  // Font files never change, and a no-store fetch stops Next from prerendering the static cards at build time.
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'force-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function download(): Promise<OgFont[]> {
  const css = await (await fetchWithTimeout(CSS_URL)).text();
  const faces = parseFontFaces(css);
  if (faces.length === 0) throw new Error('Google Fonts returned no TTF faces');
  return Promise.all(
    faces.map(async (face) => ({
      name: face.family,
      weight: face.weight,
      style: 'normal' as const,
      data: await (await fetchWithTimeout(face.url)).arrayBuffer(),
    })),
  );
}

let cached: { fonts: OgFont[]; at: number } | null = null;
let inflight: Promise<OgFont[]> | null = null;

/** Fonts for ImageResponse. Never throws: an empty list means next/og's default font is used. */
export async function loadOgFonts(): Promise<OgFont[]> {
  if (cached && (cached.fonts.length > 0 || Date.now() - cached.at < RETRY_AFTER_MS)) return cached.fonts;
  inflight ??= download()
    .catch((error: unknown) => {
      console.warn(`share card fonts unavailable, using the default font: ${error instanceof Error ? error.message : String(error)}`);
      return [] as OgFont[];
    })
    .then((fonts) => {
      cached = { fonts, at: Date.now() };
      inflight = null;
      return fonts;
    });
  return inflight;
}
