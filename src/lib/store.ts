import { del, get, set } from "idb-keyval";
import type { Shot } from "./types";

/**
 * The batch survives a refresh. Only thumbnails and OCR text are kept — the
 * original files are released once read, so a 50-shot batch stays a few MB.
 */
const KEY = "screenshot-threads:batch";

export async function loadBatch(): Promise<Shot[]> {
  try {
    const saved = (await get<Shot[]>(KEY)) ?? [];

    // OCR cannot resume across a reload: the original files are released once
    // read, so anything saved mid-read is stranded. Left alone it reports
    // "Reading…" for ever, which also blocks the analysis from running.
    return saved.map((shot) =>
      shot.status === "reading" || shot.status === "pending"
        ? {
            ...shot,
            status: "error" as const,
            error: "Reading was interrupted — add this screenshot again.",
          }
        : shot,
    );
  } catch {
    return [];
  }
}

export async function saveBatch(shots: Shot[]): Promise<void> {
  try {
    await set(KEY, shots);
  } catch {
    // Storage full or blocked in a private window — the app still works for
    // this session, it just won't survive a reload.
  }
}

export async function clearBatch(): Promise<void> {
  try {
    await del(KEY);
  } catch {
    /* nothing to recover from */
  }
}
