"""Mock of the Resend API for ops/vps-integrity/tests/run.sh.

Adapted from ops/supabase-watchdog/tests/mock.py, with three changes that let
the suite run in Git Bash on Windows as well as on Linux:

  * no hard-coded /tmp paths — a native Windows Python resolves /tmp to C:\\tmp,
    not to Git Bash's /tmp. The work dir arrives as argv[1] (MSYS converts it);
  * it binds port 0 and publishes the port it got, so it can never collide with
    the watchdog's mock (8799) or with a stale mock still holding a port;
  * GET /health answers a per-run nonce, so the suite can prove it is talking to
    THIS mock and not to a leftover one.

Usage: mock.py <work-dir> <nonce>
  <work-dir>/mode           "ok" (default) -> 200, "fail" -> 500 for /emails
  <work-dir>/attempts.jsonl every POST /emails, whatever the answer
  <work-dir>/emails.jsonl   only the ones answered 2xx (i.e. "delivered")
  <work-dir>/last.<field>   the last delivered email, decoded: subject, text,
                            to (comma-joined), from, auth (the Authorization
                            header), valid ("y" if the payload was valid JSON)
  <work-dir>/port           the TCP port it listens on

The decoded fields are written as UTF-8 files so the bash side never depends on
how a Windows console would encode Python's stdout.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

WORK, NONCE = sys.argv[1], sys.argv[2]
DEADLINE = time.time() + 900  # never outlive a forgotten test run by much


def mode():
    try:
        with open(os.path.join(WORK, 'mode'), encoding='utf-8') as f:
            return f.read().strip() or 'ok'
    except OSError:
        return 'ok'


def append(name, line):
    # newline='\n': Windows text mode would otherwise write \r\n.
    with open(os.path.join(WORK, name), 'a', encoding='utf-8', newline='\n') as f:
        f.write(line.replace('\r', '').replace('\n', '') + '\n')


def put(name, value):
    with open(os.path.join(WORK, name), 'w', encoding='utf-8', newline='\n') as f:
        f.write(value)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body):
        b = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, NONCE)
        if self.path == '/shutdown':
            global DEADLINE
            DEADLINE = 0
            return self._send(200, 'bye')
        self._send(404, '{}')

    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(n).decode('utf-8', 'replace')
        if self.path != '/emails':
            return self._send(404, '{"error":"unknown endpoint"}')
        append('attempts.jsonl', raw)
        if mode() == 'fail':
            return self._send(500, '{"statusCode":500,"message":"mock: internal error"}')
        append('emails.jsonl', raw)
        try:
            d, valid = json.loads(raw), 'y'
        except ValueError:
            d, valid = {}, 'n'
        put('last.valid', valid)
        put('last.subject', str(d.get('subject', '')))
        put('last.text', str(d.get('text', '')))
        put('last.from', str(d.get('from', '')))
        put('last.to', ','.join(d.get('to', [])))
        put('last.auth', self.headers.get('Authorization', ''))
        self._send(200, '{"id":"mock"}')


srv = HTTPServer(('127.0.0.1', 0), H)
srv.timeout = 0.5
tmp = os.path.join(WORK, 'port.tmp')
with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
    f.write(str(srv.server_address[1]))
os.replace(tmp, os.path.join(WORK, 'port'))
while time.time() < DEADLINE:
    srv.handle_request()
