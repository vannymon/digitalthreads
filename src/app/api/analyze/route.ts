import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * The analysis pass, in two flavours.
 *
 * - "ollama" (the default) runs a vision model on this machine. No API key, no
 *   cost, nothing leaves the laptop. Slower, and less sharp on the subtle
 *   cross-domain connections.
 * - "claude" sends the batch to the Anthropic API for a sharper read.
 *
 * Both return the same shape, so the rest of the app doesn't know which ran.
 */

// Local inference on a 36B model is minutes, not seconds, for a big batch.
export const maxDuration = 3600;

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.6";

const RequestSchema = z.object({
  provider: z.enum(["ollama", "claude"]).default("ollama"),
  shots: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        text: z.string(),
        /** The downscaled screenshot as a data URL, so the model can see it. */
        image: z.string().optional(),
      }),
    )
    .min(2)
    .max(50),
});

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

type Result = z.infer<typeof ResultSchema>;

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

type Shot = z.infer<typeof RequestSchema>["shots"][number];

function ocrLine(shot: Shot) {
  return shot.text.trim()
    ? `OCR text:\n${shot.text.slice(0, 4000)}`
    : "(no text found in this one — go by the image)";
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_request", message: "Need between 2 and 50 screenshots." },
      { status: 400 },
    );
  }

  const { provider, shots } = parsed.data;

  // Models cannot reliably echo 36-character UUIDs back, and a mangled id
  // silently empties a theme. They see "1", "2", "3" instead, and the real
  // ids are restored here.
  const numbered = shots.map((shot, i) => ({ ...shot, id: String(i + 1) }));

  try {
    const result =
      provider === "claude" ? await runClaude(numbered) : await runOllama(numbered);

    const themes = result.themes
      .map((theme) => ({ ...theme, shotIds: resolveIds(theme.shotIds, shots) }))
      .filter((theme) => theme.shotIds.length > 0);

    return NextResponse.json({ ...result, themes, provider });
  } catch (error) {
    return toErrorResponse(error, provider);
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
class AnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function runClaude(shots: Shot[]): Promise<Result> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AnalysisError(
      "no_key",
      "Add ANTHROPIC_API_KEY to .env.local and restart, or switch to the local model.",
      503,
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

  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(ResultSchema), effort: "medium" },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new AnalysisError("refused", "Claude declined to analyse this batch.", 422);
  }
  if (!response.parsed_output) {
    throw new AnalysisError(
      "unparsed",
      "Claude's reply did not match the expected shape.",
      502,
    );
  }
  return response.parsed_output;
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
    throw new AnalysisError(
      "ollama_unreachable",
      `Could not reach Ollama at ${OLLAMA_HOST}. Start it with "ollama serve", or switch to Claude.`,
      503,
    );
  }

  if (response.status === 404) {
    throw new AnalysisError(
      "model_missing",
      `Ollama has no model called "${OLLAMA_MODEL}". Pull it, or set OLLAMA_MODEL to one you have.`,
      503,
    );
  }
  if (!response.ok) {
    throw new AnalysisError("ollama_error", `Ollama returned ${response.status}.`, 502);
  }

  const payload = (await response.json()) as { message?: { content?: string } };
  const raw = payload.message?.content?.trim();
  if (!raw) {
    throw new AnalysisError("unparsed", "The local model returned nothing.", 502);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AnalysisError(
      "unparsed",
      "The local model's reply was not valid JSON.",
      502,
    );
  }

  const checked = ResultSchema.safeParse(parsed);
  if (!checked.success) {
    throw new AnalysisError(
      "unparsed",
      "The local model's reply did not match the expected shape.",
      502,
    );
  }
  return checked.data;
}

function toErrorResponse(error: unknown, provider: string) {
  if (error instanceof AnalysisError) {
    return NextResponse.json(
      { error: error.code, message: error.message, provider },
      { status: error.status },
    );
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return NextResponse.json(
      { error: "bad_key", message: "ANTHROPIC_API_KEY was rejected.", provider },
      { status: 401 },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return NextResponse.json(
      { error: "rate_limited", message: "Rate limited — try again shortly.", provider },
      { status: 429 },
    );
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return NextResponse.json({ error: "api_error", message, provider }, { status: 502 });
}
