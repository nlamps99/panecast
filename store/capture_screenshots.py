#!/usr/bin/env python3
"""Capture the real app's opt-in debug fixture on two already booted simulators."""
from pathlib import Path
import argparse
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--iphone', required=True)
    parser.add_argument('--ipad', required=True)
    args = parser.parse_args()
    devices = {'iphone': args.iphone, 'ipad': args.ipad}
    env = ROOT / 'client/.env.local'
    original = env.read_bytes() if env.exists() else None
    if original is not None and not original.startswith(b'EXPO_PUBLIC_STORE_SCENE='):
        raise SystemExit('Use a separate checkout without a personal .env.local for capture.')
    log = ROOT / 'client/build/ios/store-metro.log'
    temporary = Path('/tmp/panecast-store-captures')
    try:
        for scene in ('terminal', 'workspaces', 'inbox', 'settings'):
            env.write_text(f'EXPO_PUBLIC_STORE_SCENE={scene}\n')
            time.sleep(1)
            offset = log.stat().st_size
            for device in devices.values():
                subprocess.run(['xcrun', 'simctl', 'launch', '--terminate-running-process', device, 'com.nzx.panecast'], check=True, capture_output=True)
            deadline = time.monotonic() + 55
            while True:
                with log.open('rb') as f:
                    f.seek(offset)
                    fresh = f.read().decode(errors='replace')
                if all(f'[store-capture] ready:{scene}:{kind}' in fresh for kind in devices):
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError(f'Capture readiness timed out for {scene}; inspect Metro output.')
                time.sleep(1)
            for kind, device in devices.items():
                folder = temporary / kind
                folder.mkdir(parents=True, exist_ok=True)
                subprocess.run(['xcrun', 'simctl', 'io', device, 'screenshot', str(folder / f'{scene}.png')], check=True, capture_output=True)
            print(f'Captured {scene}: iPhone and iPad', flush=True)
    finally:
        if original is None:
            env.unlink(missing_ok=True)
        else:
            env.write_bytes(original)
    for kind in devices:
        shutil.copytree(temporary / kind, ROOT / 'store/screenshots/raw' / kind, dirs_exist_ok=True)
    print('Copied all eight verified-ready frames into store/screenshots/raw.', flush=True)


if __name__ == '__main__':
    main()
