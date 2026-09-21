import os, time
from http.server import BaseHTTPRequestHandler, HTTPServer
MODE = lambda: open('/tmp/wd_mode').read().strip() if os.path.exists('/tmp/wd_mode') else 'ok'
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
            if m == 'slow': time.sleep(0.6); return self._send(200, '[{"key":"x"}]')
            if m == 'hang': time.sleep(30);  return self._send(200, '[]')
            return self._send(200, '[{"key":"x"}]')
        if self.path.startswith('/functions/v1/health-check'):
            if m == 'down': return self._send(503, '{"status":"degraded","checks":{"database":"error: timeout","auth":"ok"}}')
            return self._send(200, '{"status":"ok","checks":{"database":"ok","auth":"ok"}}')
        self._send(404, '{}')
    def do_POST(self):
        n = int(self.headers.get('Content-Length', 0)); raw = self.rfile.read(n).decode()
        if '/emails' in self.path: tgt = 'email'
        elif '/messages/v1/send' in self.path: tgt = 'sms'
        else: return self._send(404, '{"error":"unknown endpoint"}')
        with open('/tmp/wd_%s.jsonl' % tgt, 'a') as f: f.write(raw + '\n')
        self._send(200, '{"id":"mock"}')
HTTPServer(('127.0.0.1', 8799), H).serve_forever()
