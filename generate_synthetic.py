#!/usr/bin/env python3
"""Generate synthetic historical data from a single JSONL snapshot."""

import json
import random
from datetime import datetime, timedelta, timezone

def load_snapshot(path: str) -> list[dict]:
    """Load the current snapshot."""
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]

def generate_daily_downloads(downloads_30d: int, days: int = 30) -> list[int]:
    """Generate plausible daily download counts that sum to downloads_30d."""
    if downloads_30d == 0:
        return [0] * days

    # Generate random weights and normalize
    weights = [random.random() + 0.1 for _ in range(days)]
    total_weight = sum(weights)

    daily = [int(downloads_30d * w / total_weight) for w in weights]

    # Adjust to match exact total
    diff = downloads_30d - sum(daily)
    for i in range(abs(diff)):
        daily[i % days] += 1 if diff > 0 else -1

    return daily

def generate_trend(base_rate: float, trend_type: str, days: int = 30) -> list[float]:
    """Generate a trend multiplier over time."""
    if trend_type == "growing":
        # Start at 60-80% of current rate, grow to 100-120%
        start = random.uniform(0.6, 0.8)
        end = random.uniform(1.0, 1.2)
    elif trend_type == "declining":
        # Start at 120-150% of current rate, decline to 80-100%
        start = random.uniform(1.2, 1.5)
        end = random.uniform(0.8, 1.0)
    elif trend_type == "spike":
        # Normal with a spike in the middle
        multipliers = [1.0] * days
        spike_start = random.randint(10, 20)
        spike_len = random.randint(3, 7)
        spike_height = random.uniform(2.0, 5.0)
        for i in range(spike_start, min(spike_start + spike_len, days)):
            multipliers[i] = spike_height
        return multipliers
    else:  # stable
        start = random.uniform(0.9, 1.1)
        end = random.uniform(0.9, 1.1)

    # Linear interpolation
    return [start + (end - start) * i / (days - 1) for i in range(days)]

def generate_history(snapshot: list[dict], days: int = 30) -> list[dict]:
    """Generate historical data working backward from snapshot."""
    end_date = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)

    # Assign trend types to repos
    trend_types = ["stable", "growing", "declining", "spike"]
    repo_trends = {}
    for repo in snapshot:
        repo_id = repo["repo"]
        # Bias toward stable, with some variation
        weights = [0.5, 0.2, 0.2, 0.1]
        repo_trends[repo_id] = random.choices(trend_types, weights=weights)[0]

    all_records = []

    for repo in snapshot:
        repo_id = repo["repo"]
        repo_type = repo["type"]
        current_30d = repo["downloads_30d"]
        current_all_time = repo["downloads_all_time"]
        current_likes = repo["likes"]

        # Generate daily download pattern
        trend = generate_trend(1.0, repo_trends[repo_id], days)
        base_daily = generate_daily_downloads(current_30d, days)

        # Apply trend to daily downloads
        daily_downloads = [max(0, int(d * t)) for d, t in zip(base_daily, trend)]

        # Generate records for each day
        for day_offset in range(days):
            record_date = end_date - timedelta(days=days - 1 - day_offset)

            # Calculate 30d window for this date
            # Sum of daily downloads from (day_offset - 29) to day_offset
            window_start = max(0, day_offset - 29)
            downloads_30d_at_date = sum(daily_downloads[window_start:day_offset + 1])

            # All-time downloads at this date
            downloads_after = sum(daily_downloads[day_offset + 1:])
            all_time_at_date = current_all_time - downloads_after

            # Likes grow slowly
            likes_growth = int((days - 1 - day_offset) * current_likes * 0.001)
            likes_at_date = max(0, current_likes - likes_growth)

            record = {
                "timestamp": record_date.isoformat(),
                "repo": repo_id,
                "type": repo_type,
                "downloads_30d": downloads_30d_at_date,
                "downloads_all_time": all_time_at_date,
                "likes": likes_at_date,
            }
            all_records.append(record)

    # Sort by timestamp, then repo
    all_records.sort(key=lambda r: (r["timestamp"], r["repo"]))

    return all_records

def main():
    import sys

    input_file = sys.argv[1] if len(sys.argv) > 1 else "hf-downloads.jsonl"
    output_file = sys.argv[2] if len(sys.argv) > 2 else "hf-downloads-synthetic.jsonl"
    days = int(sys.argv[3]) if len(sys.argv) > 3 else 30

    print(f"Loading snapshot from {input_file}")
    snapshot = load_snapshot(input_file)
    print(f"Loaded {len(snapshot)} repos")

    print(f"Generating {days} days of synthetic history...")
    history = generate_history(snapshot, days)

    print(f"Writing {len(history)} records to {output_file}")
    with open(output_file, "w") as f:
        for record in history:
            f.write(json.dumps(record) + "\n")

    print("Done!")

    # Print summary
    repos_with_trends = {}
    for record in history:
        repo = record["repo"]
        if repo not in repos_with_trends:
            repos_with_trends[repo] = {"first": record["downloads_30d"], "last": None}
        repos_with_trends[repo]["last"] = record["downloads_30d"]

    print("\nSample trends (first day -> last day downloads_30d):")
    for i, (repo, data) in enumerate(list(repos_with_trends.items())[:5]):
        change = data["last"] - data["first"]
        direction = "↑" if change > 0 else "↓" if change < 0 else "→"
        print(f"  {repo}: {data['first']} -> {data['last']} ({direction} {abs(change)})")

if __name__ == "__main__":
    main()
