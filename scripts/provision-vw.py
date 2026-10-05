#!/usr/bin/env python3
"""Hidden terminal input; credentials travel only through child stdin and HTTPS."""
import argparse
import getpass
import json
from pathlib import Path
import subprocess
import sys
import warnings


def main():
    parser = argparse.ArgumentParser(description="One-shot BuzzKey VW provisioning; no vehicle controls")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--device-key", required=True)
    parser.add_argument("--diagnostic-attempt", action="store_true")
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        print("Run directly in your local terminal; hidden interactive input is required.", file=sys.stderr)
        return 1
    warnings.simplefilter("error", getpass.GetPassWarning)
    print("Enter credentials locally. All inputs are hidden. No automatic retries.")
    try:
        credentials = {
            "username": getpass.getpass("VW username (hidden): "),
            "password": getpass.getpass("VW password (hidden): "),
            "spin": getpass.getpass("VW S-PIN (hidden): "),
        }
        payload = json.dumps(credentials)
        credentials.clear()
        result = subprocess.run(
            ["node", str(Path(__file__).with_name("vw-provision-client.mjs")), args.origin, args.device_key] + (["--diagnostic-attempt"] if args.diagnostic_attempt else []),
            input=payload, text=True, check=False,
        )
        payload = ""
        return result.returncode
    except (KeyboardInterrupt, EOFError, getpass.GetPassWarning):
        print("Provisioning cancelled; no automatic retry.", file=sys.stderr)
        return 1
    except Exception:
        print("Provisioning could not complete. Stop and review; do not retry automatically.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
