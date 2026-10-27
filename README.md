# Screenshot Threads

Drop in a batch of screenshots you saved and forgot about. It reads them, works
out what keeps coming up, and draws the connections as a graph you can explore
and export.

Built for **saved inspiration** — the social posts, articles and product shots
that pile up in a camera roll — in batches of roughly 10 to 50 at a time.

## Running it

```bash
npm run dev
```

Then open http://localhost:3000 and drop images onto the page.

## How it analyses a batch

Two passes, and the second is optional.

### Categories, not phrases

The vision passes are asked for *categories* — "Coffee", "Japanese
Architecture", "Solo Founders" — rather than phrases lifted out of a
screenshot. The specifics go in each category's one-line rationale instead,
which is what the sticky notes on the export quote.

The keyword pass cannot do this. It only has the words that appear in the
images, so it returns phrases like "cold brew"; naming a subject that is never
written down takes a model.

**1. Local pass (always runs, no network).** `tesseract.js` OCRs each image in a
small worker pool. Then `src/lib/themes.ts` scores every 1-to-3 word phrase by
tf-idf across the batch — a theme is something that recurs without being
everywhere — boosts proper nouns and longer phrases, and collapses the near
duplicates so you get "japanese joinery" rather than "japanese", "joinery" and
"japanese joinery" as three separate themes. Screenshots that share themes get
an edge, and each node keeps only its three strongest so the graph stays
readable.

**2. Vision pass (optional, one click).** Sends each screenshot — the image
itself, plus its OCR text — to a vision model, which returns better themes and
a written summary. A toggle picks which model:

| | Runs | Cost | Speed |
|---|---|---|---|
| **On this machine** (default) | `qwen3.6` via Ollama | free, fully offline | ~35s for 6 shots |
| **Claude** | `claude-opus-5-5` | ~$0.18 per 50-shot batch | ~30s |

Either way, screenshots with little or no text still carry their weight. On a
batch of four wordless colour-palette images the keyword pass found **one**
theme; the local model found **three** and Claude found **five**.

### How the two compare

They were run on the same six screenshots — two notes on Japanese joinery, two
warm palettes, two cool ones:

- **Local (qwen3.6)** pulled everything into a single joinery narrative and
  filed the blue palette under "the geometry of craftsmanship". Readable and
  free, but it over-connected.
- **Claude** kept the warm and cool palettes apart, noticed each palette was
  saved *twice* — once as stripes, once arranged into a pattern — and flagged
  the blues as not fitting the woodworking mood.

That gap is the whole trade-off. The local model is good at *what things are*;
Claude is better at *what does and doesn't belong together*. Run both on the
same batch and judge for yourself — the toggle stays available after the first
analysis, so re-running with the other model is one click.

### Setup

The local option needs [Ollama](https://ollama.com) running with a
vision-capable model:

```bash
ollama pull qwen3.6
```

Override `OLLAMA_HOST` or `OLLAMA_MODEL` in `.env.local` if your setup differs.
The Claude option needs `ANTHROPIC_API_KEY`. Neither is required — the keyword
pass always works, and the app tells you plainly if the analyser you picked
isn't reachable.

## The graph

- Drag nodes, drag the background to pan, scroll to zoom.
- Click a node for the screenshot and its extracted text.
- Hover a theme to preview its cluster, click to pin it.
- **Export image** opens the moodboard preview (below).

## The exported moodboard

**Export image** composes a moodboard rather than dumping the canvas, and shows
it in a preview first — the element you see is the element that gets captured,
so the file always matches the preview.

The board is a clean canvas with the screenshots pinned across it at varied
sizes and slight angles, the red threads drawn between the ones that share a
category. The left column carries the reading: the written summary, the top
three categories set large, the rest named in one quiet line, and a sticky note
or two quoting why the strongest ones hang together. It exports at 2x, so a
board is a 2080px-wide PNG.

Up to 15 screenshots are pinned and the top three categories get a label on the
board itself.

## Known limits

- The batch lives in IndexedDB and survives a refresh, but it is one batch at a
  time, not a growing library.
- OCR is English only (`tesseract.js` is loaded with the `eng` model). The
  Claude pass is not limited this way, since it reads the image.
- Images are downscaled to 768px before being sent, so very small text in a
  dense screenshot may be legible to the OCR pass but not to the vision model.
  Both are sent together precisely so they cover each other.
- The local model ignores the schema's request for lowercase theme labels, so
  labels are lowercased in the client to keep the two providers consistent.
