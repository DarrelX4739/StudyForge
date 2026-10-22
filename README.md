# StudyForge

**Live app: <https://darrelx4739.github.io/StudyForge/>**

A browser-only study workspace. Organise **classes → study kits → resources**, turn PDFs and pasted
text into complete **study guides**, then revise with **flashcards**, a **quiz** and a **practice
test**. Quiz attempts are saved so you can watch yourself improve.

**It works with zero setup.** Out of the box StudyForge writes guides, cards and questions with an
on-device engine that runs in the tab — no account, no API key, no server. Adding an AI key in
Settings is optional, and only there if you want richer, model-written material.

No build step, no install, no server of your own. Your data stays in your browser.

## Using the hosted app

Open <https://darrelx4739.github.io/StudyForge/> and start:

1. Click **Try a sample kit** to see a finished kit, or **New study kit** and add a PDF or paste notes.
2. Study guide, flashcards and quiz are generated straight away on device — the guide when the
   resource finishes, then cards and a quiz automatically.
3. Optional: **Settings** adds an AI provider key (Gemini, OpenRouter, a self-hosted relay or NVIDIA
   through the bundled Worker) for model-written study material and AI marking of short answers.

Everything runs in the tab. The only network calls are optional AI requests, and the app keeps
working offline once it has been opened (it is installable as an app).

### GitHub Pages deployment

The repository is a static site with no build step, so Pages serves it as-is:

- Source: the `main` branch, `/` (root) folder.
- After merging to `main`, give the Pages deployment a minute, then reload.
- Confirm the running build under **Settings → Build**, or the console line
  `[StudyForge] Ready. Build: …`. An older build means Pages has not caught up yet, or the
  browser is caching (see below).

## Running locally

Serve the folder over HTTP (not `file://`):

```bash
python3 dev-server.py          # http://localhost:8000, caching disabled
```

`dev-server.py` is `http.server` plus `Cache-Control: no-store`, so a normal reload always
shows the current build. Plain `python3 -m http.server` sends no cache headers, which lets the
browser keep serving an old `src/*.js` after you update the code — the page looks unchanged
even though the files on disk are new.

Open <http://localhost:8000> and create a study kit — no key needed. Add one in **Settings** only if
you want AI-written material.

**Confirming which build you are running:** every project file is requested with a `?v=` token
(matched in `arch/config.json` and the fallback list in `index.html`), the startup log prints
`Build: <version>`, and **Settings → Build** shows it. If that version is not the one you expect,
hard-reload with Ctrl/Cmd-Shift-R. When releasing, bump the token in both places and
`version` in `arch/init.js`.

## What you can do

### Interface

A modern, responsive layout with a grouped sidebar:

- **Engine chip** in the top bar always says where material comes from — *On-device engine*,
  the AI provider name, or *key needed*. Click it to open Settings.
- **Streak strip** on the dashboard shows consecutive study days and a 14-day activity heat strip,
  driven by real actions (guides generated, cards rated, quizzes finished).
- **Continue card** jumps straight back into the kit you last worked on.
- **Cards due** panel totals every card waiting for review and starts a due-only session in one click.

- **Sidebar** — *Overview* (Dashboard) and an expandable **Classes** tree: click a class to open its
  study kits, click a kit to open its four study modes — **Study guide**, **Flashcards**, **Quiz** and
  **Practice test**. *Data* holds export/import. Settings sits in the footer above a small storage
  meter and the current library summary. The tree follows the page you are on.
- **Colour** — a violet → ember accent on soft neutral surfaces, with a matching dark theme. The
  theme button in the sidebar header switches modes and remembers the choice.
- **Theme** — light by default; the moon/sun button in the sidebar header switches to dark and is
  remembered per browser.
- **Collapse** — the chevron folds the sidebar into an icon rail (also remembered).
- **Floating +** (bottom right) creates a study kit from anywhere.
- **Page headers** use a quiet eyebrow, a large title and actions on the right, with content in flat
  bordered rows rather than a dense card grid.

### Dashboard

- **Try a sample kit** builds a complete Biology kit (guide, 8-question quiz, 12 cards) in one click.
- **Study kits** hold resources. Each kit row shows the resource count as a large figure, its class,
  what has been generated (questions, cards, exam) and the last update.
- **Classes** group kits (e.g. *Year 11 Biology*). Create, rename and delete classes; kits are moved
  between classes from the dashboard or the kit page.
- **Rename** kits, edit their subject/focus, move them, delete them.
- **Search** (⌘K / Ctrl-K) matches kit names, subjects and resource names.
- **Export / Import** a JSON backup of everything.
- **Shortcuts** (sidebar) or **?** lists every keyboard shortcut: ⌘K search, 1–4 answers,
  Enter to mark, Space to flip, ←/→ cards.

### Study kit tabs

Each study kit is split into five tabs (each with its own URL, so back/forward and bookmarks work):

| Tab | URL | What it shows |
| --- | --- | --- |
| **Resources** | `#/kit/<id>` | Add PDFs/pasted text and see every resource with its status. |
| **Study guide** | `#/kit/<id>/documents` | Read the generated document for any resource in the kit, with copy/download. |
| **Quiz** | `#/kit/<id>/questions` | One question at a time, marked as you go, submitted at the end. |
| **Flashcards** | `#/kit/<id>/flashcards` | A revision deck written from **all** documents, with an animated card player. |
| **Practice test** | `#/kit/<id>/exam` | A timed, auto-marked multiple-choice paper from **all** documents. |

### Study kits and resources

A resource is either a **PDF** or **pasted text**. Adding one runs the extraction pipeline:

```
PDF   ┌──────────────┐   ┌───────────────┐   ┌─────────────────┐   ┌──────────────────┐
      │ read the PDF │ → │ AI gap check  │ → │ OCR only the    │ → │ AI study document│
      │ text layer   │   │ which pages   │   │ flagged pages   │   │ (saved locally)  │
      └──────────────┘   │ lost content? │   └─────────────────┘   └──────────────────┘
                         └───────────────┘
text  ┌──────────────────┐   ┌──────────────────┐
      │ pasted text      │ → │ AI study document│
      └──────────────────┘   └──────────────────┘
```

**Why the gap check exists:** a PDF's text layer is normally enough, but scanned pages, image-only
pages and vector text have none. Instead of OCR-ing every page (slow), StudyForge asks the model to
audit page-by-page character counts and previews:

- pages with **no text at all** are always OCR'd;
- pages the model flags as damaged or incomplete are OCR'd;
- if the model is unavailable (no key, rate limit, error), a local heuristic flags pages far shorter
  than the document median, and the resource notes say the gap check failed.

OCR uses Tesseract.js at the render quality and language set in **Settings**. The OCR worker is reused
across pages and jobs, and only downloaded the first time a page actually needs OCR.

The extracted text (text layer + OCR) is then merged and sent to the model in ~24 000-character
sections, each of which becomes part of one complete Markdown study document.

### Study documents

- Rendered as Markdown, or edited in place (manual corrections are saved).
- Table of contents generated from the headings, with jump links.
- Copy, download as `.md`, **Print** (prints the guide alone, not the app chrome), or **Listen** —
  the browser reads the guide aloud, offline, with no key.
- The document is saved to `localStorage`; **the uploaded file and its raw extracted text are not**.

### Quiz (per study kit)

Questions belong to the whole **study kit**: every study guide in it is covered.

A single prompt containing every document does not work — the model drifts towards whichever resource
is most salient and effectively ignores the rest. So the kit's questions are **allocated per
resource**:

1. Each resource gets a quota: one question minimum, and the remainder shared in proportion to
   document length (largest-remainder rounding, so quotas always add up to the requested count).
   With fewer questions than resources, the largest documents get them.
2. Each resource is generated **in its own request**, prompted with only that document and told
   exactly how many questions to write about it.
3. Results are interleaved (so the set is not blocked by resource) and de-duplicated.
4. If the model returns fewer than requested, or a pass fails, one bounded top-up pass asks the
   resources that did produce questions for the shortfall.

Consequences you will see in the questions tab:

- A **coverage chip per resource** showing how many questions it produced.
- Specific warnings when a resource produced none, when a newer document is not covered yet,
  and when a resource's request failed (the other resources' questions are still saved).
- Progress reports which resource is being written and how many questions it is asked for.
- Download the set as Markdown.

**How a quiz run works:**

1. **Start quiz** shows one question at a time — never the whole paper at once.
2. Choose an option, or (for short answers) type into the answer box. **Mark & next** is disabled
   until there is an answer.
3. Pressing it **marks the question immediately and locks the answer** — it cannot be changed after
   that. The correct answer, the explanation and (for short answers) the marker's feedback appear
   inline.
4. **Short answers are marked by AI**: the model compares meaning, not wording, so paraphrases,
   synonyms, abbreviations and extra correct detail are accepted. With no API key — or if the AI
   call fails — a local keyword-coverage marker is used instead and the result is labelled as
   offline marking.
5. Every question must be answered and marked; the last **See result** button **submits** the quiz.
6. The result screen shows the score, percentage, time taken and a full question-by-question review.
7. **Every submitted attempt is saved** with this study kit (up to 50) and listed under
   *Past attempts* with its score, date, time and best result. **Review** reopens any past attempt to
   show your answer beside the model answer, question by question. Regenerating the questions keeps
   the history.
8. **Practise missed** starts a fresh run containing only the questions you got wrong last time.

### Flashcards (per study kit)

A deck of revision cards, written the same way: **allocated per resource**, one request each, then
merged, de-duplicated by prompt and interleaved so the deck is not grouped by resource.

- Each card is one fact: a **front** you are cued with and a **back** you try to recall.
- Choose 10, 20, 30 or 40 cards.
- **Two deck styles**, set under **Settings → Flashcards**:
  - **Vocabulary & concepts** — the front is the *term or concept* (no question mark), the back is its
    definition or explanation. Best for definitions, names and key ideas.
  - **Exam-style questions** — the front is an actual question ending in `?`, the back is the model
    answer. Best for rehearsing how you would answer in a paper.
  The generate dialog defaults to your saved style and lets you pick the other one for a single deck;
  the deck records which style it was written in and labels the card faces accordingly.
- The player shows one card at a time. Flipping is a real 3D card-turn animation: click the card (or
  press **Space**) and it rotates to reveal the answer; new cards slide in. **←/→** move through the
  deck, and **Got it** / **Still learning** rate a card and advance.
- **Shuffle** randomises the order, **Restart** returns to the first card, **Browse all** switches to a
  plain list, and the deck can be downloaded as Markdown.
- Progress (card *n* of *N*, cards known, cards to review) is shown above the card.
- **Spaced review** is automatic. "Got it" schedules the card further out (3 days, then longer, up to
  30); "Still learning" brings it back in ten minutes. Ratings are saved per card, keyed by its
  prompt, so regenerating a deck keeps your progress. **Review N due** starts a session with only the
  cards that are due, and **Reset progress** clears the schedule.

### Practice test (per study kit)

The same material as the quiz, but as a **timed paper**:

- **Multiple choice only**, so the paper can be marked automatically — no short answers.
- Choose 10–30 questions and a time limit, or let it pick about 1¼ minutes per question (minimum 5,
  rounded to 5).
- **Start exam** begins a countdown. Questions show no feedback while the exam runs; answers are
  recorded as you click, and the header tracks how many you have answered.
- Submit early (with a confirmation if questions are unanswered) or let the clock auto-submit at zero.
  The clock keeps running if you switch tabs; reloading the page abandons the run.
- The result screen shows the score, percentage, time used, and a full review with the correct answer
  highlighted plus the explanation. **Retake** reuses the questions with a fresh clock; the last score
  is remembered on the exam's front page.

## Choosing the engine

**On-device (default).** `src/local.js` is a dependency-free generator: it reads the extracted text,
finds definitions, key sentences and cloze-worthy terms, then writes a Markdown study guide,
vocabulary cards, multiple-choice and short-answer questions, and an exam paper. It needs no key, no
network and no model, and it is what runs until you add one.

**AI (optional).** Open **Settings** and pick a provider:

| Provider | What you need | Endpoint used |
| --- | --- | --- |
| Google Gemini | A Gemini API key | `generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` |
| OpenRouter | An OpenRouter key | `openrouter.ai/api/v1/chat/completions` |
| NVIDIA (Worker) | An NVIDIA NIM key; requests go through the bundled Worker for CORS | `…workers.dev/api/notes` |
| Custom relay | Any OpenAI-compatible base URL + key | `<baseUrl>/chat/completions` |

Each provider keeps its own key, so switching back and forth never overwrites one. **Load models**
lists what the key can use, **Test connection** sends a tiny request and reports the result, and any
model id can be typed in by hand.

NVIDIA's API sends no CORS headers, so a browser cannot call it directly; that is the only reason
the Worker exists. Everything else calls the provider straight from the tab.

Short answers are marked **by AI when a key is present**, comparing meaning rather than wording. With
no key — or if the call fails — the on-device marker compares the key ideas in your answer with the
model answer (accepting paraphrases and word-form changes) and labels the result as offline marking.

## Data and privacy

| Data | Where it lives |
| --- | --- |
| Classes, kits, resources, documents, questions, quiz attempts | `localStorage` under `studyforge.study.v1` (questions and attempts live on the kit; data saved as `symus.study.v1` is migrated on load) |
| Provider API key(s) | `localStorage` (same object), one per provider, sent only with your requests |
| Uploaded PDFs and their raw extracted text | memory only, discarded when processing ends |
| Generated documents / questions | `localStorage` — use **Export** regularly |

The API key is saved in this browser so you do not have to paste it every session. Anyone with access
to this browser profile can read it; use **Settings → Delete all data** to clear everything, and never
use a shared machine with a billable key.

With the on-device engine there are **no network requests at all**. If you add an AI provider, the
request goes from your browser to that provider (or, for NVIDIA, through the bundled Worker, which
forwards it and does not store the key):

```
browser → https://symus-backend.chibbit99.workers.dev/api/notes → https://integrate.api.nvidia.com/v1/chat/completions
```

Default NVIDIA model: `nvidia/nemotron-3.5-lightning-30b-a3b`. Its strongest languages are English,
Spanish, French, German, Italian and Japanese.

`localStorage` holds roughly 5 MB. The sidebar shows usage; if it fills up, **Export** a backup and
delete old resources.

## ARCH.js runtime

The app follows the layout documented at <https://chibbit-99.github.io/arch.js/docs/>:

```
index.html            loads releases/latest.js
arch/config.json      modules: ["npmloader.js"], js: [seven project files, in order]
arch/init.js          exports STUDYFORGE_CONFIG { model, workerUrl }
src/*.js              application code executed by ARCH.js
```

- **Project files run in order.** ARCH.js fetches and executes each file in `config.json → js`:
  `store → markdown → ocr → ai → jobs → ui → main`. Each registers itself on `window.StudyForge`;
  `main.js` boots the UI once everything is present.
- **No module syntax in project files.** ARCH.js injects them as classic scripts, so there are no
  `import`/`export` statements and no top-level `await` in `src/`.
- **init.js is light.** It exports configuration only. PDF.js and Tesseract.js load on demand so the
  dashboard paints immediately; Tesseract is requested through the documented `importPackage()`
  package API with a jsDelivr ESM fallback.
- **One loader.** There is no `<script type="module" src="./src/main.js">`; the page-level fallback in
  `index.html` only fires if ARCH.js never loads or never finishes, and `main.js` refuses to boot twice.
- `releases/latest.js` is used because the documented `export const … = await importPackage(…)`
  `init.js` syntax is only supported by the current build (`v0.1.1-alpha` runs `init.js` as an async
  function, where `export` is a syntax error). ARCH.js is experimental; re-check when pinning.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | App shell, styles, ARCH.js runtime tag and fallback loader. |
| `arch/config.json` | ARCH.js modules and the ordered project file list. |
| `arch/init.js` | Exports `STUDYFORGE_CONFIG` (model, worker URL). |
| `src/local.js` | On-device study engine: text analysis, definitions, guide, cards, questions and exams with no key. |
| `src/store.js` | localStorage data model: classes, kits, resources, quiz attempts, card ratings, activity/streak, settings, backup/restore. |
| `src/markdown.js` | Small, safe Markdown renderer (HTML escaped, safe links only). |
| `src/ocr.js` | PDF.js text-layer extraction, Tesseract OCR of selected pages, text reconstruction. |
| `src/ai.js` | Multi-provider client (Gemini, OpenRouter, NVIDIA Worker, custom relay): gap analysis, generation, short-answer marking, retries, offline marking fallback. |
| `src/jobs.js` | Sequential job queue and the extraction pipeline. |
| `src/ui.js` | Dashboard, sidebar tree, kit and resource views, quiz run + result screens, flashcard player, modals, toasts, job bar. |
| `src/main.js` | Boot. |
| `worker.js` | Optional Cloudflare Worker proxying `/api/notes` to NVIDIA NIM (only needed for NVIDIA). |
| `sw.js` | Service worker: installable app, offline app shell. |
| `manifest.webmanifest`, `icon.svg` | PWA metadata and app icon. |
| `wrangler.toml` | Worker configuration. |

## Deploying the Worker (optional)

The Worker is only needed for the NVIDIA provider. Everything else — including the default
on-device engine — works without it, so you can ignore this section entirely.

```bash
npx wrangler deploy
```

```toml
name = "symus-backend"
main = "worker.js"
compatibility_date = "2026-09-01"

[vars]
SYMUS_ORIGIN = "https://chibbit-99.github.io"
SYMUS_MODEL_FILTER = "deepseek,step,nemotron,mistral,gemma,glm,muse"
SYMUS_MODELS = "nvidia/nemotron-3.5-lightning-30b-a3b"
```

| Variable | Purpose |
| --- | --- |
| `SYMUS_ORIGIN` | Comma-separated allowed browser origins. Localhost on any port is always allowed. |
| `SYMUS_MODEL_FILTER` | Substrings a model id must contain to be listed or accepted. Defaults to the seven families above. |
| `SYMUS_MODELS` | Optional extra model ids allowed even when they match no filter substring. |

Routes:

| Route | Description |
| --- | --- |
| `GET /health` | `{ "ok": true }` |
| `GET /api/models` | Requires `Authorization: Bearer <NVIDIA key>`. Proxies NVIDIA's `/v1/models`, filters to the allowed families and returns `{ models: [{ id, ownedBy }], filter, count }`. |
| `POST /api/notes` | Chat completion. Only known fields (`model`, `messages`, `max_tokens`, `temperature`, `top_p`, `chat_template_kwargs.enable_thinking`) are forwarded, `stream` is forced off, bodies are capped at 1 MB, roles and token counts are validated, and the model must match the family filter. |

The Worker never stores or logs the key — it forwards the caller's `Authorization` header.

## Limitations

- `localStorage` is per-browser and per-origin; clearing site data deletes your library. Export backups.
- OCR quality depends on scan quality, language and render scale. Very large PDFs at 3× use a lot of
  memory, and OCR runs at a few seconds per page.
- The OCR limit is 60 pages per run; any flagged pages beyond that are reported on the resource and
  need a re-run.
- Long resources are split into sections, so cross-section connections can be weaker. If a section hits
  the output-token limit the resource status says which part may be short.
- AI output can be wrong or can miss nuance: check it against the source before revising from it. The
  on-device engine is deliberately conservative — it only reuses sentences and definitions that are
  in your notes — but it is a summariser, not a tutor.
- On-device generation cannot invent explanations or mark free text semantically; it compares key
  ideas. Add an AI key for richer material and fuller marking.
- Kits with many resources mean one model request per resource, so generating a large set takes
  proportionally longer — a 40-card deck or a 30-question exam across five resources is ten requests.
- An exam run lives in memory: reloading the page or closing the tab abandons it (the saved paper and
  last score survive). A quiz run is the same — reloading mid-quiz loses that run, but every submitted
  attempt is saved.
- AI marking of short answers is a judgement call: it accepts different wordings, but can occasionally
  be generous or strict. The model answer is always shown for you to check.
- Available models depend on your provider account (and, for NVIDIA, the Worker's family filter). If
  one is missing, check **Settings → Load models** and `SYMUS_MODEL_FILTER` on the Worker.
- Not exhaustively tested in every browser; it relies on modern ES2022 features.

## Dependencies

- ARCH.js — <https://chibbit-99.github.io/arch.js/>
- PDF.js 4.4.168 — <https://mozilla.github.io/pdf.js/>
- Tesseract.js 6.0.1 — <https://github.com/naptha/tesseract.js>
- NVIDIA NIM — <https://build.nvidia.com/> (default model: Nemotron 3.5 Lightning,
  <https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b>)
- Cloudflare Workers — <https://developers.cloudflare.com/workers/>
