import { createWorker, type Worker } from "tesseract.js";

/**
 * Tesseract runs off the main thread, but spinning a worker up is expensive,
 * so a small pool is reused across the whole batch. Two is the sweet spot on a
 * laptop — more just starves the UI thread of cores.
 */
const POOL_SIZE = 2;

let pool: Promise<Worker[]> | null = null;

function getPool(): Promise<Worker[]> {
  pool ??= Promise.all(
    Array.from({ length: POOL_SIZE }, () => createWorker("eng")),
  );
  return pool;
}

export async function disposeOcr() {
  if (!pool) return;
  const workers = await pool;
  pool = null;
  await Promise.all(workers.map((w) => w.terminate()));
}

export type OcrJob = { id: string; file: File };
export type OcrResult = { id: string; text: string; error?: string };

/**
 * Reads every file, calling `onResult` as each one lands so the UI can fill in
 * progressively rather than waiting for the slowest screenshot.
 */
export async function runOcr(
  jobs: OcrJob[],
  onResult: (result: OcrResult) => void,
): Promise<void> {
  const workers = await getPool();
  const queue = [...jobs];

  await Promise.all(
    workers.map(async (worker) => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        try {
          const { data } = await worker.recognize(job.file);
          onResult({ id: job.id, text: data.text.trim() });
        } catch (err) {
          onResult({
            id: job.id,
            text: "",
            error: err instanceof Error ? err.message : "Could not read this image",
          });
        }
      }
    }),
  );
}

/**
 * Downscaled copy, used both as the graph thumbnail and as what Claude
 * actually looks at. 768px is the balance: small enough that a 50-shot batch
 * fits in IndexedDB and costs ~800 tokens an image, large enough that headings
 * and product shots are still legible.
 */
export async function makeThumb(
  file: File,
  max = 768,
): Promise<{ thumb: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, max / Math.max(width, height));
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return { thumb: canvas.toDataURL("image/jpeg", 0.75), width, height };
}
