# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A CLI tool to check download counts for Hugging Face repositories (models, datasets, spaces). Single-file Python script with no external dependencies beyond the standard library.

## Running the Tool

```bash
# Install and run with uv
uv run hf-downloads check meta-llama/Llama-2-7b-hf
uv run hf-downloads list meta-llama --all-time

# Or install globally
uv tool install .
hf-downloads check meta-llama/Llama-2-7b-hf
```

## Architecture

- `hf_downloads.py`: Complete CLI tool using argparse with two subcommands:
  - `check`: Query single repo download stats via HF API
  - `list`: List all repos for a user/org sorted by downloads
- Uses `urllib` for HTTP requests to Hugging Face API (`https://huggingface.co/api`)
- Supports `--json` flag for machine-readable output (JSONL format)
- Supports `--all-time` flag to show all-time downloads instead of 30-day stats
- `viewer.html` + `viewer.js`: browser visualization of the JSONL log using ECharts 5 from a CDN
  (pinned `echarts@5.6.0`, no build step). `hf_downloads.py` stays stdlib-only.
  - `viewer.js` is one IIFE: a pure `Core` (parse / domain / series / option building / formatters,
    exported for Node through `module.exports`) plus a thin DOM layer. `Core` touches no DOM, so
    option building is testable headlessly with real ECharts.
  - The time-range window is app state (`state.win`), written by preset chips, the `from`/`to`
    fields, the slider and wheel-zoom. Metric / log-scale changes re-patch only
    `{series, yAxis}` with `replaceMerge: ['series']` so the zoom window survives; full renders
    (`replaceMerge` including `dataZoom`, which resets it) happen only on boot, mode switch and
    repo add/remove. Never add `dataZoom` to a patch meant to keep the window.
  - Two `dataZoom` components share one window: `id:'zoom'` (slider) and `id:'ins'` (wheel zoom,
    shift-drag pan). Read the window back from `getOption().dataZoom` and intersect the
    `startValue`/`endValue` of both entries — each component reports its own view, and the
    inside-zoom's is stale after an explicit `dispatchAction`.
  - x-space is real timestamps (`time` mode) or days-since-that-repo's-first-sample
    (`align` mode); each mode remembers its own window. Axes are pinned to the whole-domain
    extent so the overview strip and the slider track stay pixel-aligned at any zoom level;
    the overview axis (index 1) has no dataZoom attached, so it is never filtered.
  - Data loads via `fetch('./hf-downloads.jsonl')`, which needs the folder served
    (`python3 -m http.server`); on `file://` the fetch fails and the file-picker path takes over.
- `generate_synthetic.py`: synthetic history generator, used to exercise the viewer
