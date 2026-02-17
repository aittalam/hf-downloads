#!/usr/bin/env python3
"""CLI tool to check download counts for Hugging Face repos."""

import argparse
import json
import sys
from datetime import datetime, timezone
from urllib.request import urlopen, Request
from urllib.error import HTTPError


API_BASE = "https://huggingface.co/api"


def get_downloads(repo_id: str, repo_type: str = "model") -> dict:
    """Fetch download stats for a HF repo."""
    expand = "?expand[]=downloadsAllTime"
    if repo_type == "model":
        url = f"{API_BASE}/models/{repo_id}{expand}"
    elif repo_type == "dataset":
        url = f"{API_BASE}/datasets/{repo_id}{expand}"
    elif repo_type == "space":
        url = f"{API_BASE}/spaces/{repo_id}{expand}"
    else:
        raise ValueError(f"Unknown repo type: {repo_type}")

    req = Request(url, headers={"User-Agent": "hf-downloads-cli/1.0"})
    try:
        with urlopen(req) as resp:
            data = json.loads(resp.read().decode())
    except HTTPError as e:
        if e.code == 404:
            print(f"❌ Repo not found: {repo_id} (type: {repo_type})")
            sys.exit(1)
        raise

    return data


def format_number(n: int) -> str:
    """Format large numbers with commas."""
    return f"{n:,}"


def list_repos(username: str, repo_type: str = "model", all_time: bool = False) -> list[dict]:
    """List all repos for a user/org."""
    expand = "&expand[]=downloadsAllTime&expand[]=likes" if all_time else ""
    if repo_type == "model":
        url = f"{API_BASE}/models?author={username}&sort=downloads&direction=-1&limit=100{expand}"
    elif repo_type == "dataset":
        url = f"{API_BASE}/datasets?author={username}&sort=downloads&direction=-1&limit=100{expand}"
    elif repo_type == "space":
        url = f"{API_BASE}/spaces?author={username}&sort=downloads&direction=-1&limit=100{expand}"
    else:
        raise ValueError(f"Unknown repo type: {repo_type}")

    req = Request(url, headers={"User-Agent": "hf-downloads-cli/1.0"})
    with urlopen(req) as resp:
        return json.loads(resp.read().decode())


def cmd_check(args):
    """Check downloads for a single repo."""
    data = get_downloads(args.repo, args.type)
    downloads_30d = data.get("downloads", 0)
    downloads_all = data.get("downloadsAllTime", None)
    likes = data.get("likes", 0)
    repo_id = data.get("id", data.get("modelId", args.repo))

    if args.json:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "repo": repo_id,
            "type": args.type,
            "downloads_30d": downloads_30d,
            "downloads_all_time": downloads_all,
            "likes": likes,
        }
        print(json.dumps(record))
        return

    print(f"📦 {repo_id}")
    if args.all_time and downloads_all is not None:
        print(f"   Downloads (all time): {format_number(downloads_all)}")
    else:
        print(f"   Downloads (30d):      {format_number(downloads_30d)}")
        if downloads_all is not None:
            print(f"   Downloads (all time): {format_number(downloads_all)}")
    print(f"   Likes:                {format_number(likes)}")


def cmd_list(args):
    """List all repos for a user with download counts."""
    repos = list_repos(args.username, args.type, all_time=args.all_time)

    if not repos:
        print(f"No {args.type}s found for user: {args.username}")
        return

    dl_key = "downloadsAllTime" if args.all_time else "downloads"
    dl_label = "Downloads (all time)" if args.all_time else "Downloads (30d)"

    if args.all_time:
        repos.sort(key=lambda r: r.get(dl_key, 0), reverse=True)

    if args.json:
        records = []
        ts = datetime.now(timezone.utc).isoformat()
        for repo in repos:
            repo_id = repo.get("id", repo.get("modelId", "unknown"))
            records.append({
                "timestamp": ts,
                "repo": repo_id,
                "type": args.type,
                "downloads_30d": repo.get("downloads", 0),
                "downloads_all_time": repo.get("downloadsAllTime", None),
                "likes": repo.get("likes", 0),
            })
        for r in records:
            print(json.dumps(r))
        return

    total_downloads = 0
    print(f"\n{'#':>4}  {'Repo':<50} {dl_label:>20} {'Likes':>8}")
    print("─" * 86)

    for i, repo in enumerate(repos, 1):
        repo_id = repo.get("id", repo.get("modelId", "unknown"))
        downloads = repo.get(dl_key, repo.get("downloads", 0))
        likes = repo.get("likes", 0)
        total_downloads += downloads
        print(f"{i:>4}  {repo_id:<50} {format_number(downloads):>20} {format_number(likes):>8}")

    print("─" * 86)
    print(f"{'':>4}  {'TOTAL':<50} {format_number(total_downloads):>20}")
    print(f"\n{len(repos)} {args.type}(s) found for {args.username}")


def main():
    parser = argparse.ArgumentParser(
        description="Check download counts for Hugging Face repos",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s check meta-llama/Llama-2-7b
  %(prog)s check meta-llama/Llama-2-7b --all-time
  %(prog)s check squad --type dataset
  %(prog)s list meta-llama
  %(prog)s list meta-llama --all-time
  %(prog)s list openai --type dataset

  # Log daily stats to a JSONL file (use with cron)
  %(prog)s check user/repo --json >> ~/hf-downloads.jsonl
  %(prog)s list user --json >> ~/hf-downloads.jsonl
        """,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # check command
    p_check = sub.add_parser("check", help="Check downloads for a single repo")
    p_check.add_argument("repo", help="Repo ID (e.g. username/repo-name)")
    p_check.add_argument(
        "--all-time", "-a",
        action="store_true",
        help="Show only all-time downloads",
    )
    p_check.add_argument(
        "--json", "-j",
        action="store_true",
        help="Output as JSON (one line, for logging/piping)",
    )
    p_check.add_argument(
        "--type", "-t",
        choices=["model", "dataset", "space"],
        default="model",
        help="Repo type (default: model)",
    )
    p_check.set_defaults(func=cmd_check)

    # list command
    p_list = sub.add_parser("list", help="List all repos for a user/org with downloads")
    p_list.add_argument("username", help="HF username or organization")
    p_list.add_argument(
        "--all-time", "-a",
        action="store_true",
        help="Show all-time downloads instead of last 30 days",
    )
    p_list.add_argument(
        "--json", "-j",
        action="store_true",
        help="Output as JSONL (one JSON object per repo, for logging/piping)",
    )
    p_list.add_argument(
        "--type", "-t",
        choices=["model", "dataset", "space"],
        default="model",
        help="Repo type (default: model)",
    )
    p_list.set_defaults(func=cmd_list)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
