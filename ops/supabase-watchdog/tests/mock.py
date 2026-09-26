import os, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
# Paths and port come from the environment so the suite also runs where /tmp
# means different things to bash and to python (Git Bash on Windows).
MODE_FILE = os.environ.get('WD_MODE_FILE', '/tmp/wd_mode')
OUT_DIR = os.environ.get('WD_OUT_DIR', '/tmp')
PORT = int(os.environ.get('WD_TEST_PORT', '8799'))
SLOW_SLEEP = float(os.environ.get('WD_SLOW_SLEEP', '0.6'))  # must exceed the suite's SLOW_MS
MODE = lambda: open(MODE_FILE).read().strip() if os.path.exists(MODE_FILE) else 'ok'
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body):
        b = body.encode(); self.send_response(code)
        self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(b)))
        self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        m = MODE()
        if self.path.startswith('/rest/v1/platform_config'):
            if m == 'down': return self._send(503, '{"message":"no connection"}')
            if m == 'slow': time.sleep(SLOW_SLEEP); return self._send(200, '[{"key":"x"}]')
            if m == 'hang': time.sleep(30);  return self._send(200, '[]')
            return self._send(200, '[{"key":"x"}]')
        if self.path.startswith('/functions/v1/health-check'):
            if m == 'down': return self._send(503, '{"status":"degraded","checks":{"database":"error: timeout","auth":"ok"}}')
            return self._send(200, '{"status":"ok","checks":{"database":"ok","auth":"ok"}}')
        self._send(404, '{}')
    def do_POST(self):
        # errors='replace': a native Windows curl re-encodes non-ASCII argv bytes
        # (the em dash in the subject) to the ANSI code page. Linux never does.
        n = int(self.headers.get('Content-Length', 0)); raw = self.rfile.read(n).decode('utf-8', errors='replace')
        if '/emails' in self.path: tgt = 'email'
        elif '/messages/v1/send' in self.path: tgt = 'sms'
        else: return self._send(404, '{"error":"unknown endpoint"}')
        with open(os.path.join(OUT_DIR, 'wd_%s.jsonl' % tgt), 'a', encoding='utf-8') as f: f.write(raw + '\n')
        self._send(200, '{"id":"mock"}')
# Threaded: the 'hang' case sleeps 30 s, and a single-threaded server would
# stall every request made by the tests that run after it.
ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
