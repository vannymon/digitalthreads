export type ShotStatus = "pending" | "reading" | "done" | "error";

export type Shot = {
  id: string;
  name: string;
  /** Downscaled preview, data URL. The original file is not kept after OCR. */
  thumb: string;
  width: number;
  height: number;
  text: string;
  status: ShotStatus;
  error?: string;
  addedAt: number;
};

export type Theme = {
  id: string;
  label: string;
  /** How strongly this theme carries the batch, 0-1. */
  weight: number;
  shotIds: string[];
  color: string;
  /** One line on what ties these together. Only the vision passes write it. */
  rationale?: string;
};

export type Link = {
  source: string;
  target: string;
  /** 0-1, how much these two screenshots have in common. */
  weight: number;
  sharedThemeIds: string[];
};

/** Which pass produced an analysis: keyword matching, or a vision model. */
export type Provider = "ollama" | "claude";

export type Analysis = {
  themes: Theme[];
  links: Link[];
  /** Null for the keyword pass, which selects phrases rather than writing prose. */
  summary: string | null;
  source: "local" | Provider;
};

export const EMPTY_ANALYSIS: Analysis = {
  themes: [],
  links: [],
  summary: null,
  source: "local",
};
