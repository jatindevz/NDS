# UI Style Doc
## Job Queue & Notification Delivery Service — Status Dashboard

**Scope:** the minimal read-only status page (PDR §12 stretch goal) — a page you'd screen-share in an interview to show the system is alive and behaving correctly under failure.
**Audience:** you (debugging), and anyone reviewing the project (interviewer, recruiter clicking a live demo link).
**The page's one job:** answer "is the queue healthy right now, and if not, why" in under two seconds — then let someone drill into a specific job.

---

## 1. Grounding in the subject

This is not a marketing page or a consumer app — it's an operator's view into a pipeline. The three real-world products it should feel closest to are Vercel's deployment list, Sentry's issue stream, and a Unix `htop`: dense, calm, numeric, and built for someone who already knows what they're looking at. Research across 2026 dashboard design consistently points to dark-mode-first as the default (not a toggle) for exactly this category of tool — monitoring and developer surfaces used in extended sessions — because it's expected, and because it reduces eye strain over long debugging sessions. Fintech and infra dashboards that earn trust do it through restraint: one accent color, strict contrast, and a single clear number up top rather than a wall of charts.

The signature idea for this page: **the pipeline itself, drawn literally.** A thin horizontal flow — queued → processing → completed / dead-letter — rendered as a live, gently animated strip of dots at the top of the page. It's not a generic KPI card; it's a shape that only makes sense for a queue, and it doubles as the "is everything okay" glance the research says should come first.

---

## 2. Design tokens

### Color

| Token | Hex | Use |
|---|---|---|
| `--bg-canvas` | `#0B0D10` | Page background. Near-black, not pure black — slight blue-gray warmth so large flat areas don't look like a void. |
| `--bg-surface` | `#14171B` | Card / row background. |
| `--bg-surface-raised` | `#1C2025` | Hover / expanded row state. |
| `--border` | `#272B31` | Hairline dividers, card borders. |
| `--text-primary` | `#E8E6E1` | Primary text. Warm off-white, not pure white — less glare on a dark surface. |
| `--text-secondary` | `#9A9791` | Timestamps, labels, secondary metadata. |
| `--text-muted` | `#5F5D58` | Disabled, placeholder. |
| `--accent` | `#F2A83C` | The one interactive accent — primary buttons, focus rings, links. A controlled amber, not the generic AI-default vermilion; chosen because it doubles as the "in-flight / processing" status color, tying the brand color to the product's own subject matter. |
| `--status-queued` | `#6B7280` | Slate gray — waiting, neutral. |
| `--status-processing` | `#F2A83C` | Same amber as accent — deliberately, since "in progress" is the state the accent color represents. |
| `--status-completed` | `#3DD68C` | Green — done, no action needed. |
| `--status-failed` | `#E8734A` | Orange-red — retrying, recoverable, not yet urgent. |
| `--status-dead-letter` | `#E14B4B` | Red — exhausted retries, needs a human. |

Five status colors is the maximum this page uses, and each maps to a real, distinct state from the data model (PDR §6) — not a decorative palette. No other colors appear anywhere on the page.

### Typography

| Role | Face | Why |
|---|---|---|
| UI text (headings, labels, body) | **Geist Sans** (fallback: Inter) | Plain, high-legibility grotesque used across Vercel's product surfaces — reads as "engineered," not "branded." |
| Data (job IDs, timestamps, payload JSON, attempt counts, durations) | **Geist Mono** (fallback: JetBrains Mono) | Monospace signals "this is raw system data" and keeps numeric columns aligned — the same pairing Vercel uses across its own dashboard for exactly this reason. |

Type scale (restrained — this page has almost no headings):
- Page title: 15px, Geist Sans, 500 weight, `--text-primary`
- Section label (e.g. "Dead-letter queue"): 12px, Geist Sans, 500 weight, uppercase, `--text-secondary`, letter-spacing 0.04em
- Job row primary (type + destination): 14px, Geist Sans, 400
- Job row data (ID, timestamp, attempts): 13px, Geist Mono, 400, `--text-secondary`
- Status badge text: 12px, Geist Mono, 500, uppercase

### Layout

No sidebar — this is a single-purpose page, not a multi-section app, so a 256px sidebar (the modern dashboard default for apps with several views) would be empty chrome here. Instead:

```
┌────────────────────────────────────────────────────┐
│  Job Queue                              ● healthy   │  ← header, health dot
├────────────────────────────────────────────────────┤
│  ○──●──●──●──○──●──○──○   (live pipeline strip)     │  ← signature element
│  queued 3   processing 2   completed 148   dlq 1    │  ← counts, mono numerals
├────────────────────────────────────────────────────┤
│  Recent jobs                                        │
│  ┌──────────────────────────────────────────────┐  │
│  │ email  →  user@x.com        ● completed   2s  │  │  ← job row, click to expand
│  │ webhook → hooks.acme.dev    ● processing  —   │  │
│  │ email  →  bad@domain        ● dead_letter 5x  │  │
│  └──────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────┤
│  Dead-letter queue (1)                    [retry]   │  ← always visible, never buried
└────────────────────────────────────────────────────┘
```

Single column, max-width 720px, centered — this is a glance-and-drill tool, not a data-dense analytics grid, so it should not try to fill a wide monitor. Progressive disclosure happens on row click: expands in place to show attempt history and `last_error`, rather than navigating to a new page.

### Signature element: the pipeline strip

A row of small circles (8px) representing the most recent N jobs in queue order, left to right, colored by current status. Circles for `processing` pulse gently (opacity 0.6 → 1.0, 1.6s loop, respecting `prefers-reduced-motion`). This is the one animated, "alive" element on the page — everything else is static. It's drawn directly from the subject (a queue *is* a sequence) rather than an invented decorative motif.

---

## 3. Components

**Status badge:** pill, `rx` fully rounded, 4px vertical / 8px horizontal padding, background = status color at 15% opacity, text = status color at full opacity, uppercase Geist Mono 12px. One badge per job row; this is the only place color carries meaning on the page, so it must stay consistent everywhere the status appears.

**Job row:** `--bg-surface`, 1px `--border`, 8px radius, 12px vertical padding. Hover → `--bg-surface-raised`, cursor pointer, no shadow (flat surfaces only, per design system baseline — shadows read as decoration on a page whose job is to look like raw system truth). Click expands a nested panel showing: full payload (JSON, Geist Mono, syntax-colored minimally — strings in `--text-secondary`, keys in `--text-primary`), attempt history as a small vertical timeline, and `last_error` in `--status-dead-letter` colored text if present.

**Health indicator (header):** a single dot + word, top-right. Green dot + "healthy" when Redis and Postgres both respond (`GET /health`). Red dot + "degraded" plus the failing component name when not — no ambiguous yellow "warning" state; this page reports fact, not sentiment.

**Empty state (no jobs yet):** "No jobs yet. Send a `POST /jobs` request to see them appear here." — written as an instruction to act, in the interface's voice, per the product's actual API, not a generic "nothing to show" placeholder.

**Dead-letter queue section:** always visible (count badge in the header even when zero), never a tab you have to remember to check — this is a deliberate structural choice: the whole point of a DLQ is that failures shouldn't be one click harder to find than successes.

---

## 4. Motion

Two motions only, both purposeful:
1. Pipeline strip pulse on `processing` circles (see §2).
2. Row expand/collapse: 150ms ease-out height transition.

No page-load animation, no hover lift, no gradient shimmer. This page is read many times a day by someone who already trusts it; extra motion would read as decorative rather than informative, and would work against the "calm, single-glance truth" goal the research consistently attributes to the dashboards that actually get used daily (Linear, Stripe, Vercel, Grafana).

All motion wrapped in `@media (prefers-reduced-motion: no-preference)`.

---

## 5. Accessibility floor

- Text contrast: `--text-primary` on `--bg-canvas` ≈ 13:1; `--text-secondary` on `--bg-surface` ≈ 5.2:1 — both clear AA at all sizes used.
- Status is never color-only: every badge carries the status word (`completed`, `dead_letter`, etc.) in text, not just a colored dot — necessary for colorblind users and for anyone reading a screenshot.
- Visible keyboard focus ring using `--accent` at 2px offset on every interactive element (job rows, retry button).
- All interactive elements reachable and operable via keyboard (row expand = Enter/Space on focused row).

---

## 6. What this page deliberately avoids

- No sidebar, no multi-page nav — this is a single-purpose tool, and adding navigation chrome for a page with one screen's worth of content would be the "generic dashboard template" failure mode the research flags: visual complexity added without a real second view to justify it.
- No chart library, no line graphs — a queue's health is answered by counts and statuses, not a time-series; adding a chart would be decoration standing in for information.
- No light mode as the default — dark-first, per the dev-tool convention this page belongs to (a light theme can be added later as a toggle, but is not the design center).
