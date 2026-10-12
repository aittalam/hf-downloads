# hf-downloads

A zero-dependency Python CLI tool to check download counts for Hugging Face repos. Uses the public HF API — no authentication required.

## Features

- Check download stats for a single repo (model, dataset, or space)
- List all repos for a user/org with a ranked table
- View **last 30 days** or **all-time** download counts
- JSON output for logging and piping

## Installation

Requires Python 3.10+

```bash
# Run directly with uv
uv run hf-downloads check meta-llama/Llama-2-7b-hf

# Or install as a tool
uv tool install .
hf-downloads check meta-llama/Llama-2-7b-hf
```

## Commands

### `check` — Single repo stats

```bash
hf-downloads check username/repo-name
hf-downloads check username/my-dataset --type dataset
hf-downloads check username/my-space --type space
hf-downloads check username/repo-name --json
```

### `list` — All repos for a user/org

```bash
# list all repos sorted by downloads (30d):
hf-downloads list username

# list all repos sorted by downloads (all time):
hf-downloads list username --all-time

hf-downloads list username --type dataset
hf-downloads list username --json
```

## Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--all-time` | `-a` | Show/sort by all-time downloads instead of last 30 days |
| `--json` | `-j` | Output as JSON (one line per repo) for logging/piping |
| `--type` | `-t` | Repo type: `model` (default), `dataset`, or `space` |

## JSON Output

When using `--json`, each line is a standalone JSON object:

```json
{
  "timestamp": "2025-01-15T12:00:00+00:00",
  "repo": "username/my-model",
  "type": "model",
  "downloads_30d": 1234,
  "downloads_all_time": 45678,
  "likes": 56
}
```

## Tracking Downloads Over Time

Since the HF API doesn't expose per-day download history, use `--json` with cron to build your own daily log:

```bash
# Add to crontab (crontab -e)
# Track a single repo daily at midnight
0 0 * * * hf-downloads check username/repo-name --json >> ~/hf-downloads.jsonl 2>&1

# Track all repos for a user daily at midnight
0 0 * * * hf-downloads list username --all-time --json >> ~/hf-downloads.jsonl 2>&1
```

Query your log:

```bash
# See all entries for a specific repo
grep "username/my-model" ~/hf-downloads.jsonl | python3 -m json.tool

# Extract timestamps and download counts with jq
cat ~/hf-downloads.jsonl | jq '{date: .timestamp[:10], repo: .repo, downloads: .downloads_all_time}'
```

## Visualizing Download History

### viewer.html + viewer.js

Open `viewer.html` in a browser to explore your JSONL log as an interactive chart. It uses
ECharts from a CDN (so it needs network access); your data is read locally and never uploaded.

Serve the folder so the viewer can auto-load `hf-downloads.jsonl`:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/viewer.html
```

Opening the file directly works too — the browser blocks the auto-load, so pick or drag your
JSONL instead.

| Control | What it does |
|---------|--------------|
| Range chips `30d 90d 180d 1y All` | Window anchored at the newest sample; `All` = whole file |
| `from` / `to` date fields | Exact calendar window; chips deselect when you customise |
| Overview strip + slider | Strip below the chart shows the **full** timeline (total change per day); drag its window to zoom |
| Wheel / shift-drag on the plot | Zoom and pan; the date fields follow the slider, so you always know what range you're looking at |
| Metric dropdown | 30d downloads (bars), all-time (cumulative line), daily delta (bars), likes |
| Log scale checkbox | Signed-log y axis — works with zero and negative values (see below) |
| Log scale / Align timeline | Align switches the x-axis to "days since that repo's first sample" and keeps its own window, in day units |
| Repo chips + dropdown | Add/remove repos; colours are sticky, HF tags shown as dots |

The selected range **persists**: switching metric, toggling log scale, or adding/removing repos
never resets the zoom (time mode and align mode each remember their own window).

The `points in window · days · repos` line reports how thin the data really is — a daily metric
spread over months is noise-dominated.

Notes on the `daily` metric: it is the change of `downloads_all_time` between consecutive
samples, so each repo's first sample is dropped, deltas can be negative (HF's 30-day counter
uses a moving window), and samples closer than 0.25 days are not joined (two pulls within an
hour shouldn't read as zero change).

### Log scale and zero values

Zero is common in this data, not an error: `likes` is 0 for most repos, and a repo sits at 0
downloads until its first crawl (`mozilla-ai/encoderfile` has 85 zero days before it starts
being counted). A plain log axis cannot show that: `log(0)` is −Infinity, so ECharts hands back
`y = Infinity` for a zero point and `y = NaN` for a negative one — the point simply disappears,
and clipping the value to 0 changes nothing because 0 is the un-placeable case.

So the checkbox plots a **signed log** (`sign(v) · log10(1 + |v|)`) on a normal axis: 0 lands on
the zero line, negative deltas point down, magnitudes stay compressed, and tick labels read as
decades (0, 10, 100, 1K…). Tooltips always show the real count. It behaves like `symlog` in
matplotlib — the near-zero region is linear, which is what you want when most of the series is
literally zero.

### generate_synthetic.py

Generate synthetic historical data from a single snapshot for testing visualizations:

```bash
uv run python generate_synthetic.py [input.jsonl] [output.jsonl] [days]

# Examples
uv run python generate_synthetic.py                          # uses defaults
uv run python generate_synthetic.py hf-downloads.jsonl       # 30 days of history
uv run python generate_synthetic.py data.jsonl out.jsonl 60  # 60 days of history
```

Creates realistic trends (stable, growing, declining, spike) for each repo.

## Notes

- Fetches up to 100 repos per `list` call (HF API limit)
- Spaces don't have meaningful download counts — use mainly for likes
