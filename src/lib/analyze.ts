import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Provider } from "./types";

/**
 * The analysis pass, in two flavours. Both run from the browser, so the app is
 * a static site with no server of its own and can be hosted anywhere.
 *
 * - "ollama" calls a vision model on the visitor's own machine. No API key, no
 *   cost, nothing leaves the laptop. Slower, and less sharp on the subtle
 *   cross-domain connections.
 * - "gemini" sends the batch to Google's Gemini API on its free tier, with the
 *   visitor's own key. Free, works from a phone, but rate limited.
 * - "claude" sends the batch to the Anthropic API with the visitor's own key.
 *
 * Both return the same shape, so the rest of the app doesn't know which ran.
 */

const OLLAMA_HOST = process.env.NEXT_PUBLIC_OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.NEXT_PUBLIC_OLLAMA_MODEL ?? "qwen3.6";
// The alias follows Google's current Flash model, which the free tier covers.
const GEMINI_MODEL = process.env.NEXT_PUBLIC_GEMINI_MODEL ?? "gemini-flash-latest";

type Shot = {
  id: string;
  name: string;
  text: string;
  /** The downscaled screenshot as a data URL, so the model can see it. */
  image?: string;
};

const DATA_URL = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/;

const ResultSchema = z.object({
  themes: z
    .array(
      z.object({
        label: z
          .string()
          .describe(
            "The subject this belongs to, as a category: one to three words in " +
              "Title Case, like 'Coffee', 'Japanese Architecture' or 'Pricing'.",
          ),
        rationale: z.string().describe("One sentence on what ties these together."),
        shotIds: z
          .array(z.string())
          .min(1)
          .describe(
            "The id of every screenshot in this category, copied from its " +
              "<screenshot id=\"...\"> tag. Never empty — a category with no " +
              "screenshots is not a category.",
          ),
      }),
    )
    .describe("Three to eight categories, strongest first."),
  summary: z
    .string()
    .describe(
      "Three or four sentences: what this collection is really about, the " +
        "throughlines, and anything surprising or contradictory.",
    ),
});

export type Result = z.infer<typeof ResultSchema>;

const SYSTEM = `You are reading a batch of screenshots someone saved as inspiration.

For each one you get the image itself and, where there was any, its OCR text.
The image is the better source for what a screenshot is *of* — a product, a
room, a diagram, a piece of clothing — while the OCR catches small text the
downscaled image may have blurred. Use both, and trust the image when they
disagree. Ignore interface chrome, timestamps and engagement counts.

Many of these will be mostly picture with little or no text. Those are not
empty: describe what is actually depicted and let it carry a theme.

Group these into the handful of subjects the person is actually interested in,
and name each one as a category rather than as a phrase lifted from a
screenshot. "Coffee", not "cold brew steeping". "Japanese Architecture", not
"kanawa tsugi joint". "Pricing", not "charge per outcome".

Pitch them so a stranger could read the list and know what this person is into:
narrower than "Design" or "Business", broader than any single screenshot. Three
words at the very most — "Coffee", "Japanese Architecture", "Solo Founders".

Keep distinct subjects apart. Screenshots about coffee and screenshots about
woodworking are "Coffee" and "Woodworking", never one merged "Craft and
Process" — an umbrella that spans unrelated subjects is worse than no category
at all. Merge only when two groups really are the same subject. A screenshot
can belong to several categories, or to none.

List, in shotIds, the id of every screenshot that belongs to the category —
the number in its <screenshot id="..."> tag. This is what draws the
connections, so a category with an empty list is useless.

The rationale is where the specifics go — name the actual details there. Then
say what the collection is really about, including the throughline the person
may not have noticed themselves.`;

function ocrLine(shot: Shot) {
  return shot.text.trim()
    ? `OCR text:\n${shot.text.slice(0, 4000)}`
    : "(no text found in this one — go by the image)";
}

export async function analyse(
  provider: Provider,
  shots: Shot[],
  apiKey?: string,
): Promise<Result> {
  if (shots.length < 2 || shots.length > 50) {
    throw new AnalysisError("Need between 2 and 50 screenshots.");
  }

  // Models cannot reliably echo 36-character UUIDs back, and a mangled id
  // silently empties a theme. They see "1", "2", "3" instead, and the real
  // ids are restored here.
  const numbered = shots.map((shot, i) => ({ ...shot, id: String(i + 1) }));

  try {
    const result =
      provider === "claude"
        ? await runClaude(numbered, apiKey)
        : provider === "gemini"
          ? await runGemini(numbered, apiKey)
          : await runOllama(numbered);

    const themes = result.themes
      .map((theme) => ({ ...theme, shotIds: resolveIds(theme.shotIds, shots) }))
      .filter((theme) => theme.shotIds.length > 0);

    return { ...result, themes };
  } catch (error) {
    throw toAnalysisError(error);
  }
}

/** Accepts "3", "shot-3", or a real id, and returns the real ids. */
function resolveIds(ids: string[], shots: Shot[]): string[] {
  const resolved = new Set<string>();
  for (const raw of ids) {
    if (shots.some((s) => s.id === raw)) {
      resolved.add(raw);
      continue;
    }
    const digits = String(raw).match(/\d+/)?.[0];
    const index = digits ? Number(digits) : NaN;
    if (Number.isInteger(index) && index >= 1 && index <= shots.length) {
      resolved.add(shots[index - 1].id);
    }
  }
  return [...resolved];
}

/** Thrown for conditions we want to explain to the user in plain words. */
export class AnalysisError extends Error {}

async function runClaude(shots: Shot[], apiKey?: string): Promise<Result> {
  if (!apiKey?.trim()) {
    throw new AnalysisError(
      "Paste an Anthropic API key above, or switch to the local model.",
    );
  }

  // One text header, then the picture, then whatever OCR found — repeated per
  // screenshot so the id, the image and the text stay bound together.
  const content: Anthropic.ContentBlockParam[] = [];
  for (const shot of shots) {
    content.push({ type: "text", text: `<screenshot id="${shot.id}" name="${shot.name}">` });

    const match = shot.image?.match(DATA_URL);
    if (match) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: match[1] as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
          data: match[2],
        },
      });
    }

    content.push({ type: "text", text: `${ocrLine(shot)}\n</screenshot>` });
  }

  // The key is the visitor's own and only ever goes to Anthropic, which is
  // what makes calling the API straight from the page acceptable here.
  const client = new Anthropic({ apiKey: apiKey.trim(), dangerouslyAllowBrowser: true });
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ResultSchema), effort: "medium" },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new AnalysisError("Claude declined to analyse this batch.");
  }
  if (!response.parsed_output) {
    throw new AnalysisError("Claude's reply did not match the expected shape.");
  }
  return response.parsed_output;
}

async function runGemini(shots: Shot[], apiKey?: string): Promise<Result> {
  if (!apiKey?.trim()) {
    throw new AnalysisError(
      "Paste a Gemini API key above — it's free from aistudio.google.com/apikey.",
    );
  }

  // Same shape as the Claude path: header, picture, OCR, per screenshot.
  const parts: Record<string, unknown>[] = [];
  for (const shot of shots) {
    parts.push({ text: `<screenshot id="${shot.id}" name="${shot.name}">` });
    const match = shot.image?.match(DATA_URL);
    if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    parts.push({ text: `${ocrLine(shot)}\n</screenshot>` });
  }

  // Gemini takes plain JSON Schema but rejects the "$schema" marker.
  const { $schema: _marker, ...schema } = z.toJSONSchema(ResultSchema);
  void _marker;

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: schema,
            temperature: 0.4,
          },
        }),
      },
    );
  } catch {
    throw new AnalysisError("Could not reach the Gemini API. Check your connection.");
  }

  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as {
      error?: { message?: string; status?: string };
    } | null;
    const status = detail?.error?.status;
    if (status === "INVALID_ARGUMENT" && /api key/i.test(detail?.error?.message ?? "")) {
      throw new AnalysisError("Google rejected that Gemini API key.");
    }
    if (response.status === 429 || status === "RESOURCE_EXHAUSTED") {
      throw new AnalysisError(
        "Gemini's free tier limit was hit. Wait a minute and try again, or use a smaller batch.",
      );
    }
    throw new AnalysisError(
      `Gemini returned ${response.status}${detail?.error?.message ? `: ${detail.error.message}` : "."}`,
    );
  }

  const payload = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  if (payload.promptFeedback?.blockReason) {
    throw new AnalysisError("Gemini declined to analyse this batch.");
  }
  const raw = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!raw) {
    throw new AnalysisError("Gemini returned nothing.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnalysisError("Gemini's reply was not valid JSON.");
  }

  const checked = ResultSchema.safeParse(parsed);
  if (!checked.success) {
    throw new AnalysisError("Gemini's reply did not match the expected shape.");
  }
  return checked.data;
}

async function runOllama(shots: Shot[]): Promise<Result> {
  // Ollama attaches images to a message rather than to a position in the text,
  // so each screenshot gets its own message. That keeps the id, the picture
  // and the OCR bound together the way the Claude path does with blocks.
  const messages = [
    { role: "system", content: SYSTEM },
    ...shots.map((shot) => {
      const match = shot.image?.match(DATA_URL);
      return {
        role: "user",
        content: `<screenshot id="${shot.id}" name="${shot.name}">\n${ocrLine(shot)}\n</screenshot>`,
        ...(match ? { images: [match[2]] } : {}),
      };
    }),
  ];

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        stream: false,
        // Thinking roughly doubles the wait on a batch this size; the themes
        // hold up well enough without it.
        think: false,
        format: z.toJSONSchema(ResultSchema),
        options: { num_ctx: 32768, temperature: 0.4 },
      }),
    });
  } catch {
    // From a hosted copy of the app the browser also needs Ollama to accept
    // this site's origin, which it refuses by default.
    const hosted = !/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    throw new AnalysisError(
      hosted
        ? `Could not reach Ollama at ${OLLAMA_HOST}. Make sure it is running, and that OLLAMA_ORIGINS includes ${window.location.origin} — or switch to Gemini.`
        : `Could not reach Ollama at ${OLLAMA_HOST}. Start it with "ollama serve", or switch to Gemini.`,
    );
  }

  if (response.status === 404) {
    throw new AnalysisError(
      `Ollama has no model called "${OLLAMA_MODEL}". Pull it, or set NEXT_PUBLIC_OLLAMA_MODEL to one you have.`,
    );
  }
  if (!response.ok) {
    throw new AnalysisError(`Ollama returned ${response.status}.`);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const raw = payload.message?.content?.trim();
  if (!raw) {
    throw new AnalysisError("The local model returned nothing.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnalysisError("The local model's reply was not valid JSON.");
  }

  const checked = ResultSchema.safeParse(parsed);
  if (!checked.success) {
    throw new AnalysisError(
      "The local model's reply did not match the expected shape.",
    );
  }
  return checked.data;
}

function toAnalysisError(error: unknown): AnalysisError {
  if (error instanceof AnalysisError) return error;
  if (error instanceof Anthropic.AuthenticationError) {
    return new AnalysisError("Anthropic rejected that API key.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AnalysisError("Rate limited — try again shortly.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new AnalysisError("Could not reach the Anthropic API. Check your connection.");
  }
  return new AnalysisError(error instanceof Error ? error.message : "Unknown error");
}
