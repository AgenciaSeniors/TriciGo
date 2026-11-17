#!/usr/bin/env python3
"""Drive the Android emulator by reading the screen as text, for QA rounds.

The screen is read with `uiautomator dump` (text, content-desc, resource-id and
bounds of every node), so an agent can work the apps without screenshots.
Standard library only.

Usage (from the repo root):
  python scripts/qa/adb_ui.py open client|driver   open the dev client on the local Metro
  python scripts/qa/adb_ui.py dump [--all]         visible nodes and where to tap them
  python scripts/qa/adb_ui.py find TEXT            nodes whose text, description or id contains TEXT
  python scripts/qa/adb_ui.py tap TEXT [--index N] tap the Nth match (exact matches first)
  python scripts/qa/adb_ui.py tapxy X Y
  python scripts/qa/adb_ui.py type TEXT            ASCII only (adb input text)
  python scripts/qa/adb_ui.py clear [N]            delete N characters in the focused field (default 40)
  python scripts/qa/adb_ui.py key BACK|HOME|ENTER|TAB|...
  python scripts/qa/adb_ui.py swipe up|down|left|right
  python scripts/qa/adb_ui.py wait TEXT [--timeout S] [--gone]
  python scripts/qa/adb_ui.py logs [--grep X]      ReactNativeJS lines and crashes since the last `logs --clear`
  python scripts/qa/adb_ui.py screenshot FILE.png

TEXT matching ignores case and accents. Environment: ADB (path to adb),
ANDROID_SERIAL (which device, when more than one is attached).
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET

APPS = {
    'client': ('app.tricigo.client', 'exp+tricigo-client', 8081),
    'driver': ('app.tricigo.driver', 'exp+tricigo-driver', 8082),
}
BOUNDS_RE = re.compile(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]')


def adb_path() -> str:
    if os.environ.get('ADB'):
        return os.environ['ADB']
    local = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk', 'platform-tools', 'adb.exe')
    if os.path.exists(local):
        return local
    found = shutil.which('adb')
    if not found:
        sys.exit('adb not found: set ADB to its path')
    return found


def adb(*args: str, check: bool = True, binary: bool = False):
    proc = subprocess.run([adb_path(), *args], capture_output=True)
    if check and proc.returncode != 0:
        sys.exit(f'adb {" ".join(args)} failed: {proc.stderr.decode(errors="replace").strip()}')
    return proc.stdout if binary else proc.stdout.decode('utf-8', errors='replace')


def fold(s: str) -> str:
    """Lowercase without accents, for matching."""
    return ''.join(c for c in unicodedata.normalize('NFKD', s or '') if not unicodedata.combining(c)).lower()


class Node:
    def __init__(self, el: ET.Element, idx: int):
        self.idx = idx
        self.text = el.get('text', '')
        self.desc = el.get('content-desc', '')
        self.rid = el.get('resource-id', '').split(':id/')[-1]
        self.cls = el.get('class', '').rsplit('.', 1)[-1]
        self.clickable = el.get('clickable') == 'true'
        self.checked = el.get('checked') == 'true'
        self.enabled = el.get('enabled') == 'true'
        self.focused = el.get('focused') == 'true'
        m = BOUNDS_RE.match(el.get('bounds', ''))
        self.box = tuple(int(g) for g in m.groups()) if m else (0, 0, 0, 0)

    @property
    def center(self) -> tuple[int, int]:
        x1, y1, x2, y2 = self.box
        return (x1 + x2) // 2, (y1 + y2) // 2

    @property
    def visible(self) -> bool:
        x1, y1, x2, y2 = self.box
        return x2 > x1 and y2 > y1

    def label(self) -> str:
        parts = []
        if self.text:
            parts.append(f'"{self.text}"')
        if self.desc and self.desc != self.text:
            parts.append(f'desc="{self.desc}"')
        if self.rid:
            parts.append(f'id={self.rid}')
        flags = [f for f, on in (('click', self.clickable), ('checked', self.checked),
                                 ('disabled', not self.enabled), ('focused', self.focused)) if on]
        cx, cy = self.center
        return f'#{self.idx:<3} {" ".join(parts) or self.cls} @({cx},{cy})' + (f' [{",".join(flags)}]' if flags else '')


class DumpFailed(Exception):
    pass


def try_dump_nodes() -> list[Node]:
    last_err = ''
    for _ in range(4):
        proc = subprocess.run([adb_path(), 'shell', 'uiautomator', 'dump', '/sdcard/qa_ui.xml'], capture_output=True)
        out = (proc.stdout + proc.stderr).decode('utf-8', errors='replace').strip()
        if 'dumped to' in out:
            xml = adb('exec-out', 'cat', '/sdcard/qa_ui.xml', binary=True)
            root = ET.fromstring(xml)
            return [Node(el, i) for i, el in enumerate(root.iter('node'))]
        last_err = out or f'no output (exit {proc.returncode})'
        time.sleep(0.8)  # uiautomator fails while the screen animates
    # Persistent failures with no output usually mean Android itself is down
    # (DeadSystemException in `logs`), not that the screen keeps moving.
    raise DumpFailed(f'uiautomator dump failed: {last_err}')


def dump_nodes() -> list[Node]:
    try:
        return try_dump_nodes()
    except DumpFailed as exc:
        sys.exit(str(exc))


def foreground() -> str:
    out = adb('shell', 'dumpsys', 'activity', 'activities', check=False)
    m = re.search(r'topResumedActivity=.*? ([\w.]+)/([\w.$]+)', out)
    return f'{m.group(1)}/{m.group(2)}' if m else '?'


def matches(nodes: list[Node], query: str) -> list[Node]:
    q = fold(query)
    hits = [n for n in nodes if n.visible and any(q in fold(v) for v in (n.text, n.desc, n.rid))]
    exact = [n for n in hits if q in (fold(n.text), fold(n.desc), fold(n.rid))]
    return exact + [n for n in hits if n not in exact]


def cmd_dump(args):
    nodes = dump_nodes()
    print(f'foreground: {foreground()}')
    for n in nodes:
        if n.visible and (args.all or n.text or n.desc):
            print(n.label())


def cmd_find(args):
    hits = matches(dump_nodes(), args.text)
    for n in hits:
        print(n.label())
    if not hits:
        sys.exit(f'not found: {args.text}')


def tap_xy(x: int, y: int):
    adb('shell', 'input', 'tap', str(x), str(y))


def cmd_tap(args):
    hits = matches(dump_nodes(), args.text)
    if len(hits) <= args.index:
        sys.exit(f'not found: {args.text} (matches: {len(hits)})')
    node = hits[args.index]
    tap_xy(*node.center)
    print(f'tapped {node.label()}')


def cmd_tapxy(args):
    tap_xy(args.x, args.y)


def cmd_type(args):
    if any(ord(c) > 127 for c in args.text):
        sys.exit('adb input text only takes ASCII: write it without accents (search ignores them)')
    escaped = ''.join('%s' if c == ' ' else (c if c.isalnum() or c in '.,-_@:/+' else '\\' + c) for c in args.text)
    adb('shell', 'input', 'text', escaped)


def cmd_clear(args):
    adb('shell', 'input', 'keyevent', 'KEYCODE_MOVE_END')
    adb('shell', 'input', 'keyevent', *(['KEYCODE_DEL'] * args.n))


def cmd_key(args):
    name = args.name.upper()
    adb('shell', 'input', 'keyevent', name if name.startswith('KEYCODE_') else f'KEYCODE_{name}')


def cmd_swipe(args):
    w, h = (int(v) for v in re.search(r'(\d+)x(\d+)', adb('shell', 'wm', 'size')).groups())
    cx, cy = w // 2, h // 2
    dx, dy = {'up': (0, -h // 3), 'down': (0, h // 3), 'left': (-w // 3, 0), 'right': (w // 3, 0)}[args.direction]
    # "up" moves the content up (scrolls down the page), like a finger swipe.
    adb('shell', 'input', 'swipe', str(cx - dx // 2), str(cy - dy // 2), str(cx + dx // 2), str(cy + dy // 2), '300')


def cmd_wait(args):
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        try:
            nodes = try_dump_nodes()
        except DumpFailed as exc:
            print(exc, file=sys.stderr)  # keep waiting: the screen may still be loading
            continue
        hits = matches(nodes, args.text)
        if bool(hits) != args.gone:
            print(hits[0].label() if hits else f'gone: {args.text}')
            return
        time.sleep(1)
    sys.exit(f'timeout after {args.timeout}s waiting for {"absence of " if args.gone else ""}{args.text}')


def cmd_open(args):
    pkg, scheme, port = APPS[args.app]
    adb('reverse', f'tcp:{port}', f'tcp:{port}')
    adb('shell', 'am', 'force-stop', pkg)
    url = f'{scheme}://expo-development-client/?url=http%3A%2F%2Flocalhost%3A{port}'
    print(adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, pkg).strip())


def cmd_logs(args):
    if args.clear:
        adb('logcat', '-c')
        return
    out = adb('logcat', '-d', '-v', 'time', 'ReactNativeJS:V', 'ReactNative:W', 'AndroidRuntime:E', '*:S')
    for line in out.splitlines():
        if not args.grep or fold(args.grep) in fold(line):
            print(line)


def cmd_screenshot(args):
    with open(args.file, 'wb') as fh:
        fh.write(adb('exec-out', 'screencap', '-p', binary=True))
    print(args.file)


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('open'); s.add_argument('app', choices=APPS); s.set_defaults(fn=cmd_open)
    s = sub.add_parser('dump'); s.add_argument('--all', action='store_true'); s.set_defaults(fn=cmd_dump)
    s = sub.add_parser('find'); s.add_argument('text'); s.set_defaults(fn=cmd_find)
    s = sub.add_parser('tap'); s.add_argument('text'); s.add_argument('--index', type=int, default=0); s.set_defaults(fn=cmd_tap)
    s = sub.add_parser('tapxy'); s.add_argument('x', type=int); s.add_argument('y', type=int); s.set_defaults(fn=cmd_tapxy)
    s = sub.add_parser('type'); s.add_argument('text'); s.set_defaults(fn=cmd_type)
    s = sub.add_parser('clear'); s.add_argument('n', type=int, nargs='?', default=40); s.set_defaults(fn=cmd_clear)
    s = sub.add_parser('key'); s.add_argument('name'); s.set_defaults(fn=cmd_key)
    s = sub.add_parser('swipe'); s.add_argument('direction', choices=('up', 'down', 'left', 'right')); s.set_defaults(fn=cmd_swipe)
    s = sub.add_parser('wait'); s.add_argument('text'); s.add_argument('--timeout', type=float, default=30)
    s.add_argument('--gone', action='store_true'); s.set_defaults(fn=cmd_wait)
    s = sub.add_parser('logs'); s.add_argument('--grep'); s.add_argument('--clear', action='store_true'); s.set_defaults(fn=cmd_logs)
    s = sub.add_parser('screenshot'); s.add_argument('file'); s.set_defaults(fn=cmd_screenshot)
    args = p.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
