"""Run the teaches-before-probe judge on the labelled turns (fixtures/teach_judge_labels.json) and report where it disagrees.

    cd ai-service
    set -a; . .env; set +a
    uv run python -I ../evals/tutoring/calibrate_teach_judge.py --max-usd 1 --out /tmp/v31-evals/teach-judge-calibration

Target: no labelled-true turn missed, at most two false positives. The labels are never changed to fit the judge; the prompt is.
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main(argv=None) -> int:
    import run_eval as host

    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--judge", default=host.DEFAULT_JUDGE, metavar="MODEL:EFFORT")
    parser.add_argument("--max-usd", type=float, default=1.0)
    parser.add_argument("--out", type=Path, required=True, help="folder for the per-turn verdicts and result.json (a fresh folder re-judges)")
    parser.add_argument("--only", default=None, help="judge only the labelled turns whose id ends with one of these comma-separated parts (for example /426) (a partial re-check after a prompt change)")
    parser.add_argument("--mock", action="store_true")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--env-file", type=Path, default=host.AI_SERVICE_DIR / ".env")
    args = parser.parse_args(argv)

    spend, adapters = host.load_generation_helpers()
    import teach_judge

    api_key = "" if args.mock else adapters.load_api_key(args.env_file)
    if not args.mock and not api_key:
        raise SystemExit("ANTHROPIC_API_KEY is not set")
    if api_key:
        from app.config import settings

        settings.ANTHROPIC_API_KEY = api_key
    spec = adapters.parse_model_spec(args.judge if ":" in args.judge else f"{args.judge}:medium")
    labels = teach_judge.load_labels()
    if args.only:
        parts = [p.strip() for p in args.only.split(",") if p.strip()]
        labels = [l for l in labels if any(l["id"].endswith(p) for p in parts)]
    tracker = spend.SpendTracker(args.max_usd, args.max_usd, adapters.estimate_cost)
    provider = adapters.MeteredProvider(adapters.build_provider(mock=args.mock, api_key=api_key, timeout=args.timeout), spec, tracker, spend.JUDGE)
    result = asyncio.run(teach_judge.calibrate(provider, labels=labels, judge_dir=args.out / "verdicts", log=host.log))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"judge {spec.label}: agree {result['agree']} of {result['judged']} (of {result['n']} labelled), ${result['cost_usd']:.3f}")
    for kind in ("misses", "false_positives"):
        for item in result[kind]:
            print(f"  {kind.replace('misses', 'miss').replace('false_positives', 'false positive')}{' (borderline)' if item['borderline'] else ''} {item['id']}\n    turn: {item['turn']}\n    label: {item['label_reason']}\n    judge: {item['judge_reason']}")
    if result["unjudged"]:
        print(f"  not judged: {result['unjudged']}")
    return 0 if teach_judge.meets_target(result) else 1


if __name__ == "__main__":
    sys.exit(main())
