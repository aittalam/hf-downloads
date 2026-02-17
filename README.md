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

## Notes

- Fetches up to 100 repos per `list` call (HF API limit)
- Spaces don't have meaningful download counts — use mainly for likes
