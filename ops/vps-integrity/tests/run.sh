#!/bin/bash
# TriciGo — test suite for the VPS integrity alarm (ops/vps-integrity/integrity-check.sh).
#
# Drives the REAL script against a fixture filesystem (INTEGRITY_ROOT), fake
# ss / systemctl / dpkg / sshd, a fixture /proc and a local mock of the Resend
# API, so every alert path is proven rather than assumed. Includes NEGATIVE
# cases (Resend refusing, no channel, missing config): a verification that has
# never been seen to fail is not a verification.
#
# Usage:  ops/vps-integrity/tests/run.sh
# Needs:  bash 4+, curl, ssh-keygen, sha256sum, python3 (or `python` 3).
#         Runs on Linux and in Git Bash on Windows. Touches nothing outside its
#         own temp dir — a fake `logger` on PATH catches the journal lines, so
#         the test run does not land in the real journal either.
#
# Platform notes (Git Bash on Windows):
#   * NTFS has no setuid bits, no backslashes in file names and no POSIX modes,
#     so the SUID, dpkg-escaping and permission tests are SKIPPED there. They
#     run on Linux.
#   * Fixture symlinks (the fake /proc/<pid>/exe) are made with
#     MSYS=winsymlinks:sys, which needs no admin rights.
#   * INTEGRITY_TEST_REQUIRE_ALL=1 turns every skip into a failure. CI sets it,
#     so a green run there means every test actually ran.
#   * INTEGRITY_TEST_KEEP=1 keeps the temp dir (fixtures, state, every email the
#     mock received) for a post-mortem, and prints where it is.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../integrity-check.sh"
WORK="$(mktemp -d)"
MOCK_PID=""; PORT=""
cleanup() {
  [[ -n "$PORT" ]] && curl -s --max-time 2 "http://127.0.0.1:$PORT/shutdown" >/dev/null 2>&1
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  if [[ "${INTEGRITY_TEST_KEEP:-0}" == "1" ]]; then echo "kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

pass=0; fail=0; skip=0
ok()  { echo "  ok    $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }
chk()    { if [[ "$2" == "$3" ]];  then ok "$1"; else bad "$1 (want='$3' got='$2')"; fi; }
has()    { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 (missing '$3')"; fi; }
hasnt()  { if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1 (unexpected '$3')"; fi; }
# hasline: some line of $2 is exactly $3 (substring checks can pass by accident)
hasline() { if grep -qxF -- "$3" <<<"$2"; then ok "$1"; else bad "$1 (no line '$3')"; fi; }
# hasrow: some line of $2 is $3, optionally followed by a space and more (e.g. a
# "new" marker) — so "+ curl" matches "+ curl  <- NUEVO" but not "+ curlx".
hasrow() {
  if awk -v p="$3" 'index($0, p) == 1 && (length($0) == length(p) || substr($0, length(p) + 1, 1) == " ") { f = 1 }
                    END { exit !f }' <<<"$2"; then ok "$1"; else bad "$1 (no row '$3')"; fi
}
skipped() {
  if [[ "${INTEGRITY_TEST_REQUIRE_ALL:-0}" == "1" ]]; then
    bad "$1 — skipped ($2) but INTEGRITY_TEST_REQUIRE_ALL=1"
  else
    echo "  skip  $1 — $2"; skip=$((skip+1))
  fi
}
yn() { if "$@"; then echo y; else echo n; fi; }

# ── python for the mock ───────────────────────────────────
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 \
     && "$c" -c 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)' >/dev/null 2>&1; then
    PY="$c"; break
  fi
done
[[ -n "$PY" ]] || { echo "FATAL: need python3 (or python 3) for the mock Resend server"; exit 1; }

bash -n "$SCRIPT" || { echo "FATAL: integrity-check.sh has a syntax error"; exit 1; }

# ── mock Resend ───────────────────────────────────────────
MOCK="$WORK/mock"; mkdir -p "$MOCK"; echo ok > "$MOCK/mode"
NONCE="vps-integrity-$$-$RANDOM"
"$PY" "$HERE/mock.py" "$MOCK" "$NONCE" 2> "$MOCK/stderr.log" & MOCK_PID=$!
up=0
# Generous: a cold Python start on Windows (antivirus) can take many seconds.
for _ in $(seq 1 240); do
  if [[ -s "$MOCK/port" ]]; then
    PORT="$(tr -d '\r\n' < "$MOCK/port")"
    # The nonce proves we reach THIS run's mock, not a stale one on some port.
    if [[ "$(curl -s --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null)" == "$NONCE" ]]; then up=1; break; fi
  fi
  sleep 0.25
done
if (( ! up )); then
  echo "FATAL: the mock Resend server did not come up within 60 s"
  sed 's/^/  mock: /' "$MOCK/stderr.log" 2>/dev/null
  exit 1
fi
export RESEND_API_URL="http://127.0.0.1:$PORT/emails"

# A fake logger first on PATH: the journal lines land in a file the tests can
# read, instead of in the real journal of whoever runs the suite.
mkdir -p "$WORK/pathbin"
cat > "$WORK/pathbin/logger" <<'EOF'
#!/bin/bash
tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in -t) tag="$2"; shift 2 ;; --) shift; break ;; *) break ;; esac
done
printf '%s: %s\n' "$tag" "$*" >> "${INTEGRITY_TEST_SYSLOG:?}"
EOF
chmod +x "$WORK/pathbin/logger"
export PATH="$WORK/pathbin:$PATH" INTEGRITY_TEST_SYSLOG="$WORK/syslog"

emails()   { if [[ -f "$MOCK/emails.jsonl"   ]]; then grep -c '' < "$MOCK/emails.jsonl";   else echo 0; fi; }
attempts() { if [[ -f "$MOCK/attempts.jsonl" ]]; then grep -c '' < "$MOCK/attempts.jsonl"; else echo 0; fi; }
last() { cat "$MOCK/last.$1" 2>/dev/null; }

# ── fixture: a small Ubuntu-shaped root ───────────────────
R="$WORK/root"; FX="$WORK/fx"; BIN="$WORK/bin"; PROC="$WORK/proc"
mkdir -p "$R" "$FX" "$BIN" "$PROC"
put() { mkdir -p "$(dirname "$R$1")"; printf '%s\n' "${2:-# $1}" > "$R$1"; }

# Git Bash: symlinks without admin rights. Ignored everywhere else.
export MSYS="${MSYS:+$MSYS }winsymlinks:sys"
CAN_SYMLINK=0
if ln -s "/nonexistent/probe (deleted)" "$WORK/.lprobe" 2>/dev/null \
   && [[ "$(readlink "$WORK/.lprobe")" == "/nonexistent/probe (deleted)" ]]; then CAN_SYMLINK=1; fi

put /etc/passwd 'root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
sync:x:4:65534:sync:/bin:/bin/sync
www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin
deploy:x:1000:1000:Deploy:/home/deploy:/bin/bash'
# SECRETHASH marks the one value that must never reach a file, a log or an email.
put /etc/shadow 'root:$6$saltsalt$SECRETHASHrootSECRETHASH:19999:0:99999:7:::
daemon:*:19999:0:99999:7:::
sync:*:19999:0:99999:7:::
www-data:*:19999:0:99999:7:::
deploy:!:19999:0:99999:7:::'
put /etc/group 'root:x:0:
adm:x:4:syslog
sudo:x:27:deploy
www-data:x:33:
deploy:x:1000:'
mkdir -p "$R/var/www" "$R/home/deploy"

ssh-keygen -q -t ed25519 -N '' -C 'owner@laptop' -f "$WORK/k_owner" >/dev/null 2>&1
ssh-keygen -q -t ed25519 -N '' -C 'intruder@vps' -f "$WORK/k_intruder" >/dev/null 2>&1
FP_OWNER="$(ssh-keygen -E sha256 -lf "$WORK/k_owner.pub" | awk '{print $2}')"
FP_INTRUDER="$(ssh-keygen -E sha256 -lf "$WORK/k_intruder.pub" | awk '{print $2}')"
BODY_OWNER="$(awk '{print $2}' "$WORK/k_owner.pub")"
BODY_INTRUDER="$(awk '{print $2}' "$WORK/k_intruder.pub")"
[[ "$FP_OWNER" == SHA256:* && "$FP_INTRUDER" == SHA256:* ]] || { echo "FATAL: ssh-keygen did not produce test keys"; exit 1; }
mkdir -p "$R/root/.ssh"; cp "$WORK/k_owner.pub" "$R/root/.ssh/authorized_keys"

put /etc/sudoers 'root ALL=(ALL:ALL) ALL
@includedir /etc/sudoers.d'
put /etc/sudoers.d/README
put /etc/systemd/system/tricigo-web.service '[Service]
ExecStart=/usr/bin/node server.js'
put /usr/lib/systemd/system/ssh.service '[Service]'
put /usr/lib/systemd/system/cloud-thing.service '[Service]'
put /usr/lib/systemd/system/aliased.service '[Service]'
put /lib/systemd/system/legacy.service '[Service]'
if (( CAN_SYMLINK )); then
  mkdir -p "$R/etc/systemd/system/multi-user.target.wants"
  ln -s /etc/systemd/system/tricigo-web.service "$R/etc/systemd/system/multi-user.target.wants/tricigo-web.service"
fi
put /etc/crontab
put /etc/cron.d/e2scrub_all
put /etc/cron.daily/logrotate
put /etc/hosts '127.0.0.1 localhost'
put /etc/bash.bashrc
put /root/.bashrc
put /root/.profile
put /etc/profile.d/01-locale-fix.sh
put /etc/ssh/sshd_config
put /var/log/apt/history.log '
Start-Date: 2026-09-20  06:25:01
Commandline: /usr/bin/unattended-upgrade
Upgrade: openssl:amd64 (3.0.13-0ubuntu3.5, 3.0.13-0ubuntu3.6)
End-Date: 2026-09-20  06:25:09'

printf '%s\n' /usr/lib/systemd/system/ssh.service /lib/systemd/system/legacy.service \
  /lib/systemd/system/aliased.service /usr/bin/sudo > "$FX/dpkg-owned"
cat > "$FX/ss-listen" <<'SS'
tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=812,fd=6),("nginx",pid=811,fd=6))
tcp   LISTEN 0      4096         0.0.0.0:22        0.0.0.0:*    users:(("systemd",pid=1,fd=50),("sshd",pid=700,fd=3))
tcp   LISTEN 0      511        127.0.0.1:3003      0.0.0.0:*    users:(("next-server (v1",pid=900,fd=21))
udp   UNCONN 0      0      127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=520,fd=14))
udp   UNCONN 0      0            0.0.0.0:45678     0.0.0.0:*    users:(("chronyd",pid=600,fd=5))
SS
cat > "$FX/ss-established" <<'SS'
0      0        10.0.0.5:22       203.0.113.9:51234  users:(("sshd",pid=1500,fd=4))
0      0       127.0.0.1:41000      127.0.0.1:3003   users:(("nginx",pid=812,fd=30))
0      0       127.0.0.1:3003       127.0.0.1:41000  users:(("next-server (v1",pid=900,fd=25))
0      0        10.0.0.5:52000   140.82.112.21:443   users:(("Runner.Listener",pid=1200,fd=90))
SS
printf '%s\n' 'ssh.service                enabled         enabled' \
  'tricigo-web.service        enabled         enabled' > "$FX/systemctl-enabled"
cat > "$FX/sshd-T" <<'SSHD'
port 22
permitrootlogin prohibit-password
pubkeyauthentication yes
passwordauthentication no
authorizedkeysfile .ssh/authorized_keys .ssh/authorized_keys2
x11forwarding no
SSHD

# Fake commands. They read the fixtures through INTEGRITY_TEST_FX.
cat > "$BIN/ss" <<'EOF'
#!/bin/bash
FX="${INTEGRITY_TEST_FX:?}"
case " $* " in
  *" established "*) cat "$FX/ss-established" ;;
  *" -tulpn "*)      cat "$FX/ss-listen" ;;
  *) exit 1 ;;
esac
EOF
cat > "$BIN/systemctl" <<'EOF'
#!/bin/bash
FX="${INTEGRITY_TEST_FX:?}"
[[ " $* " == *" list-unit-files "* ]] || exit 1
cat "$FX/systemctl-enabled"
EOF
# Like dpkg-query -S: "pkg: /path" for owned paths, a notice on stderr and exit
# 1 for the rest. Arguments are glob patterns where \ escapes the next char, so
# undo that escaping before the lookup — exactly what fnmatch() does in dpkg.
cat > "$BIN/dpkg" <<'EOF'
#!/bin/bash
FX="${INTEGRITY_TEST_FX:?}"
[[ "${1:-}" == "-S" ]] || exit 2
shift; rc=0
for q in "$@"; do
  p="$(printf '%s' "$q" | sed 's/\\\(.\)/\1/g')"
  if grep -qxF -- "$p" "$FX/dpkg-owned"; then echo "fakepkg: $p"
  else echo "dpkg-query: no path found matching pattern $q" >&2; rc=1; fi
done
exit $rc
EOF
cat > "$BIN/sshd" <<'EOF'
#!/bin/bash
FX="${INTEGRITY_TEST_FX:?}"
[[ "${1:-}" == "-T" ]] || exit 1
if [[ -f "$FX/sshd-fail" ]]; then echo "Missing privilege separation directory: /run/sshd" >&2; exit 255; fi
cat "$FX/sshd-T"
EOF
chmod +x "$BIN"/*

mkproc() {   # pid exe argv...   (exe "" = kernel thread: no exe link, empty cmdline)
  local pid="$1" exe="$2"; shift 2
  mkdir -p "$PROC/$pid"
  if [[ -n "$exe" ]]; then ln -s "$exe" "$PROC/$pid/exe"; printf '%s\0' "$@" > "$PROC/$pid/cmdline"
  else : > "$PROC/$pid/cmdline"; fi
}
if (( CAN_SYMLINK )); then
  mkproc 1 /usr/lib/systemd/systemd /sbin/init splash
  mkproc 2 ""
  mkproc 812 /usr/sbin/nginx "nginx: master process /usr/sbin/nginx"
fi

# The config is SHARED with the Supabase watchdog: keys the alarm does not use
# must be ignored and must never leak. ALERT_EMAIL_TO is deliberately unquoted
# WITH a space after the comma — a sourced env file loses that variable entirely.
CFG="$WORK/supabase-health.env"
cat > "$CFG" <<'ENV'
# TriciGo — shared alert config
SUPABASE_URL=https://example.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_test
D7_API_TOKEN=d7_secret_must_never_leak
RESEND_API_KEY=re_test_must_never_leak
ALERT_EMAIL_TO=a@x.com, b@x.com
ALERT_EMAIL_FROM=noreply@tricigo.com
ENV

export INTEGRITY_CONFIG="$CFG" INTEGRITY_STATE_DIR="$WORK/state" INTEGRITY_ROOT="$R" \
       INTEGRITY_PROC_DIR="$PROC" INTEGRITY_TEST_FX="$FX" \
       INTEGRITY_CMD_SS="$BIN/ss" INTEGRITY_CMD_SYSTEMCTL="$BIN/systemctl" \
       INTEGRITY_CMD_DPKG="$BIN/dpkg" INTEGRITY_CMD_SSHD="$BIN/sshd"
HOST="$(hostname 2>/dev/null | tr -d '\r')"; [[ -n "$HOST" ]] || HOST="$(uname -n)"
ALL_OUT="$WORK/all-output.log"
OUT=""; RC=0; TXT=""; e0=0
run() { OUT="$(bash "$SCRIPT" "$@" 2>&1)"; RC=$?; printf '%s\n' "$OUT" >> "$ALL_OUT"; TXT="$(last text)"; }
new_emails() { echo $(( $(emails) - e0 )); }

# ══════════════════════════════════════════════════════════
echo "A. config guardrails (negative)"
OUT="$(INTEGRITY_CONFIG="$WORK/nope.env" INTEGRITY_STATE_DIR="$WORK/state-a1" bash "$SCRIPT" 2>&1)"; RC=$?
chk "missing config: non-zero exit"      "$(yn test "$RC" -ne 0)" "y"
has "missing config: says why"           "$OUT" "missing or unreadable"
chk "missing config: no baseline written" "$(yn test -e "$WORK/state-a1/baseline")" "n"
grep -v '^RESEND_API_KEY=' "$CFG" > "$WORK/nochan.env"
OUT="$(INTEGRITY_CONFIG="$WORK/nochan.env" INTEGRITY_STATE_DIR="$WORK/state-a2" bash "$SCRIPT" 2>&1)"; RC=$?
chk "no channel: non-zero exit"          "$(yn test "$RC" -ne 0)" "y"
has "no channel: says why"               "$OUT" "no alert channel"
chk "no channel: no baseline written"    "$(yn test -e "$WORK/state-a2/baseline")" "n"
chk "nothing was emailed"                "$(attempts)" "0"

echo "B. --selftest proves the alert path, and passes only if Resend accepted it"
e0=$(emails); run --selftest
chk "exit 0"                             "$RC" "0"
has "honest verdict"                     "$OUT" "selftest: OK"
chk "one email delivered"                "$(new_emails)" "1"
chk "payload is valid JSON"              "$(last valid)" "y"
chk "'a@x.com, b@x.com' unquoted -> 2 recipients" "$(last to)" "a@x.com,b@x.com"
has "subject says it is a test"          "$(last subject)" "PRUEBA"
chk "API key only in the Authorization header" "$(last auth)" "Bearer re_test_must_never_leak"
chk "a selftest writes no baseline"      "$(yn test -e "$WORK/state/baseline")" "n"
echo fail > "$MOCK/mode"
e0=$(emails); run --selftest
chk "Resend 500: non-zero exit"          "$(yn test "$RC" -ne 0)" "y"
has "Resend 500: says FALLO"             "$OUT" "selftest: FALLO"
chk "Resend 500: nothing delivered"      "$(new_emails)" "0"
echo ok > "$MOCK/mode"
OUT="$(INTEGRITY_CONFIG="$WORK/nochan.env" bash "$SCRIPT" --selftest 2>&1)"; RC=$?
chk "no channel: non-zero exit"          "$(yn test "$RC" -ne 0)" "y"
has "no channel: says FALLO"             "$OUT" "selftest: FALLO"
OUT="$(INTEGRITY_CONFIG="$WORK/nope.env" bash "$SCRIPT" --selftest 2>&1)"; RC=$?
chk "missing config: non-zero exit"      "$(yn test "$RC" -ne 0)" "y"
# A config copied from Windows arrives with CRLF line endings.
sed 's/$/\r/' "$CFG" > "$WORK/crlf.env"
e0=$(emails)
OUT="$(INTEGRITY_CONFIG="$WORK/crlf.env" bash "$SCRIPT" --selftest 2>&1)"; RC=$?
chk "CRLF config: exit 0"                "$RC" "0"
chk "CRLF config: recipients clean"      "$(last to)" "a@x.com,b@x.com"
chk "CRLF config: delivered"             "$(new_emails)" "1"

echo "C. first run creates the baseline silently; an unchanged box stays silent"
e0=$(emails); run
chk "exit 0"                             "$RC" "0"
has "logs 'baseline created'"            "$OUT" "baseline created"
chk "no email"                           "$(new_emails)" "0"
BASE="$WORK/state/baseline"
chk "baseline written"                   "$(yn test -s "$BASE")" "y"
BL="$(cat "$BASE" 2>/dev/null)"
has    "ssh_key: owner key by fingerprint"        "$BL" "ssh_key root $FP_OWNER owner@laptop"
has    "account: uid 0"                           "$BL" "account uid0 root"
hasline "account: login shell"                    "$BL" "account shell deploy /bin/bash"
hasnt  "account: nologin is not a login shell"    "$BL" "account shell www-data"
hasnt  "account: /bin/sync is not a login shell"  "$BL" "account shell sync"
hasline "account: sudo member"                    "$BL" "account group sudo deploy"
hasline "account: adm member"                     "$BL" "account group adm syslog"
hasline "account: primary group root"             "$BL" "account group root root"
hasline "account: usable password, name only"     "$BL" "account password root"
hasnt  "account: a locked password is not usable" "$BL" "account password deploy"
has    "sudoers: file hashed"                     "$BL" "sudoers /etc/sudoers.d/README "
hasline "unit: enabled unit"                      "$BL" "unit enabled ssh.service"
has    "unit: /etc/systemd/system file hashed"    "$BL" "unit file /etc/systemd/system/tricigo-web.service "
has    "unit_unpackaged: unit no package owns"    "$BL" "unit_unpackaged /usr/lib/systemd/system/cloud-thing.service "
hasnt  "unit_unpackaged: dpkg-owned unit skipped" "$BL" "unit_unpackaged /usr/lib/systemd/system/ssh.service"
hasnt  "unit_unpackaged: usrmerge alias (registered /lib, found /usr/lib)" "$BL" "aliased.service"
hasnt  "unit_unpackaged: owned under /lib"        "$BL" "legacy.service"
has    "cron: file hashed"                        "$BL" "cron /etc/cron.d/e2scrub_all "
has    "cron: cron.daily watched too"             "$BL" "cron /etc/cron.daily/logrotate "
has    "boot: file hashed"                        "$BL" "boot /etc/hosts "
hasline "boot: sshd -T value"                     "$BL" "boot sshd permitrootlogin prohibit-password"
hasnt  "boot: sshd -T keys outside the list"      "$BL" "boot sshd x11forwarding"
# One line per process: on a socket-activated sshd only "systemd" holds :22
# after a reboot until the first login — that must read as a removal (ignored),
# not as a brand-new "sshd,systemd" -> "systemd" entry (an alert).
hasline "listen: one line per process (1/2)"      "$BL" "listen tcp 0.0.0.0:22 sshd"
hasline "listen: one line per process (2/2)"      "$BL" "listen tcp 0.0.0.0:22 systemd"
chk    "listen: duplicate names collapse"         "$(grep -c '^listen tcp 0.0.0.0:80 ' "$BASE")" "1"
hasline "listen: a name with a space survives"    "$BL" "listen tcp 127.0.0.1:3003 next-server (v1"
hasline "listen: udp low port kept"               "$BL" "listen udp 127.0.0.53%lo:53 systemd-resolve"
hasnt  "listen: udp >= 32768 dropped"             "$BL" "45678"
hasline "outbound: client side of a connection"   "$BL" "outbound Runner.Listener"
hasline "outbound: loopback client too"           "$BL" "outbound nginx"
hasnt  "outbound: accepted (inbound) ssh ignored" "$BL" "outbound sshd"
hasnt  "outbound: server side of a local conn"    "$BL" "outbound next-server"
hasnt  "outbound: never records IPs"              "$BL" "140.82.112.21"
chk    "proc: nothing for normal processes"       "$(grep -c '^proc ' "$BASE")" "0"
if (( CAN_SYMLINK )); then
  hasline "unit: symlink recorded by target"      "$BL" "unit link /etc/systemd/system/multi-user.target.wants/tricigo-web.service -> /etc/systemd/system/tricigo-web.service"
else
  skipped "unit: symlink recorded by target" "this shell cannot create symlinks"
fi
hasnt  "never stores the shadow hash"             "$BL" "SECRETHASH"
hasnt  "never stores a key body"                  "$BL" "$BODY_OWNER"
e0=$(emails); run
chk "unchanged: exit 0"                  "$RC" "0"
has "unchanged: logs ok"                 "$OUT" "ok: no changes"
chk "unchanged: no email"                "$(new_emails)" "0"
run --show
chk "--show: exit 0"                     "$RC" "0"
has "--show: says there is nothing"      "$OUT" "sin diferencias"

echo "D. a new authorized key (hidden .ssh of a nologin account) -> exactly one email"
mkdir -p "$R/var/www/.ssh"; cat "$WORK/k_intruder.pub" >> "$R/var/www/.ssh/authorized_keys"
e0=$(emails); run --show
has "--show lists it"                    "$OUT" "ssh_key www-data $FP_INTRUDER"
chk "--show sends nothing"               "$(new_emails)" "0"
e0=$(emails); run
chk "exit 0"                             "$RC" "0"
has "logs ALERT SENT"                    "$OUT" "ALERT SENT"
chk "exactly one email"                  "$(new_emails)" "1"
chk "subject"                            "$(last subject)" "TriciGo VPS — cambio sospechoso detectado"
chk "payload is valid JSON"              "$(last valid)" "y"
chk "both recipients"                    "$(last to)" "a@x.com,b@x.com"
has "body: category"                     "$TXT" "ssh_key"
has "body: the fingerprint"              "$TXT" "$FP_INTRUDER"
has "body: grouped +line with the account" "$TXT" "+ www-data $FP_INTRUDER"
has "body: hostname"                     "$TXT" "$HOST"
has "body: UTC time"                     "$TXT" "UTC"
has "body: how to accept"                "$TXT" "/etc/tricigo/integrity-check.sh --accept"
has "body: last apt run, for triage"     "$TXT" "2026-09-20"
chk "body: multi-line (newlines kept)"   "$(yn test "$(printf '%s' "$TXT" | grep -c '')" -gt 10)" "y"
hasnt "body: no key body"                "$TXT" "$BODY_INTRUDER"
e0=$(emails); run
chk "same diff again: no second email"   "$(new_emails)" "0"
has "same diff again: says so"           "$OUT" "same changes"
run --accept
chk "--accept: exit 0"                   "$RC" "0"
has "--accept: logged"                   "$OUT" "baseline accepted"
e0=$(emails); run
chk "after --accept: no email"           "$(new_emails)" "0"
has "after --accept: ok"                 "$OUT" "ok: no changes"

echo "E. a new file in sudoers.d -> email"
printf 'www-data ALL=(ALL) NOPASSWD: ALL\n' > "$R/etc/sudoers.d/99-backdoor"
e0=$(emails); run
chk "one email"                          "$(new_emails)" "1"
has "names the category"                 "$TXT" "sudoers"
has "names the file"                     "$TXT" "/etc/sudoers.d/99-backdoor"
hasnt "does not copy the file content"   "$TXT" "NOPASSWD"
run --accept

echo "F. gsocket-shaped backdoor: fake kernel thread + outbound + enabled unit"
if (( CAN_SYMLINK )); then
  plant() {
    mkproc 6666 "/root/.config/htop/defunct (deleted)" "[netns]"
    echo '0      0        10.0.0.5:53000   45.33.32.156:443   users:(("defunct",pid=6666,fd=3))' >> "$FX/ss-established"
    echo 'defunct.service            enabled         enabled' >> "$FX/systemctl-enabled"
    printf '[Service]\nExecStart=/usr/bin/defunct\n' > "$R/etc/systemd/system/defunct.service"
  }
  unplant() {
    rm -rf "$PROC/6666"; rm -f "$R/etc/systemd/system/defunct.service"
    sed -i '/defunct/d' "$FX/ss-established" "$FX/systemctl-enabled"
  }
  plant
  e0=$(emails); run
  chk "one email"                        "$(new_emails)" "1"
  has "proc: category"                   "$TXT" "proc"
  has "proc: fake kernel thread"         "$TXT" "fake_kthread /root/.config/htop/defunct [netns]"
  has "proc: deleted exe in a hidden dir" "$TXT" "exe_deleted /root/.config/htop/defunct"
  has "outbound: category"               "$TXT" "outbound"
  hasrow "outbound: the new process"     "$TXT" "+ defunct"
  has "unit: enabled"                    "$TXT" "defunct.service"
  hasnt "no remote IP in the email"      "$TXT" "45.33.32.156"
  unplant
  e0=$(emails); run
  chk "cleaned up: no email"             "$(new_emails)" "0"
  has "cleaned up: back to baseline"     "$OUT" "back to baseline"
  plant
  e0=$(emails); run
  chk "it comes back: told again"        "$(new_emails)" "1"
  unplant; run
else
  skipped "F. fake /proc fixture" "this shell cannot create symlinks"
fi

echo "G. Resend refuses (500): not marked as alerted, so the next run retries"
echo fail > "$MOCK/mode"
printf '* * * * * root /tmp/.x/beacon\n' > "$R/etc/cron.d/evil"
e0=$(emails); a0=$(attempts); run
chk "exit 1 (not delivered)"             "$RC" "1"
has "logs the failure"                   "$OUT" "ALERT NOT DELIVERED"
chk "one attempt"                        "$(( $(attempts) - a0 ))" "1"
chk "nothing delivered"                  "$(new_emails)" "0"
a0=$(attempts); run
chk "retried on the next run"            "$(( $(attempts) - a0 ))" "1"
echo ok > "$MOCK/mode"
e0=$(emails); run
chk "delivered once Resend is back"      "$(new_emails)" "1"
chk "exit 0"                             "$RC" "0"
has "it is the pending change"           "$TXT" "/etc/cron.d/evil"
e0=$(emails); run
chk "now marked: no repeat"              "$(new_emails)" "0"
run --accept

echo "H. listen/proc/outbound are allow-lists: new entries alert, vanished ones do not"
sed -i '/0.0.0.0:80 /d' "$FX/ss-listen"
e0=$(emails); run
chk "a listener going away: no email"    "$(new_emails)" "0"
echo 'tcp   LISTEN 0      5            0.0.0.0:4444      0.0.0.0:*    users:(("nc",pid=4444,fd=3))' >> "$FX/ss-listen"
e0=$(emails); run
chk "a new listener: email"              "$(new_emails)" "1"
has "names it"                           "$TXT" "0.0.0.0:4444 nc"
has "category"                           "$TXT" "listen"
echo '0      0        10.0.0.5:54000   93.184.216.34:443  users:(("curl",pid=7777,fd=5))' >> "$FX/ss-established"
e0=$(emails); run
chk "a new outbound process: email"      "$(new_emails)" "1"
hasrow "names it"                        "$TXT" "+ curl"
sed -i '/"curl"/d' "$FX/ss-established"
e0=$(emails); run
chk "the connection closes: no email"    "$(new_emails)" "0"
run --accept
has "--accept says what it keeps allowed" "$OUT" "outbound curl"
echo '0      0        10.0.0.5:54001   93.184.216.34:443  users:(("curl",pid=7778,fd=5))' >> "$FX/ss-established"
e0=$(emails); run
chk "--accept allowed the alerted process" "$(new_emails)" "0"
echo 'tcp   LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=812,fd=6))' >> "$FX/ss-listen"
sed -i '/"nc"/d' "$FX/ss-listen"; sed -i '/"curl"/d' "$FX/ss-established"
e0=$(emails); run
chk "known listener back, nc gone: no email" "$(new_emails)" "0"

echo "I. a shrinking alert is not re-sent; a new change on top of it is"
printf 'a\n' > "$R/etc/cron.d/x1"; printf 'b\n' > "$R/etc/cron.d/x2"
e0=$(emails); run
chk "two changes: one email"             "$(new_emails)" "1"
rm -f "$R/etc/cron.d/x2"
e0=$(emails); run
chk "one undone: no email"               "$(new_emails)" "0"
printf 'c\n' > "$R/etc/cron.d/x3"
e0=$(emails); run
chk "a new change on top: email"         "$(new_emails)" "1"
chk "marks the new line"                 "$(grep -F '/etc/cron.d/x3' <<<"$TXT" | grep -c 'NUEVO')" "1"
chk "still lists the pending one, unmarked" "$(grep -F '/etc/cron.d/x1' <<<"$TXT" | grep -vc 'NUEVO')" "1"
has "says how many are new (singular)"   "$TXT" "(1 nuevo desde el último aviso"
rm -f "$R/etc/cron.d/x1" "$R/etc/cron.d/x3"
e0=$(emails); run
chk "all undone: no email"               "$(new_emails)" "0"
has "back to baseline"                   "$OUT" "back to baseline"

echo "J. after a reboot, before the first SSH login (socket-activated sshd): no false alarm"
# sshd -T fails without /run/sshd, and only systemd holds :22 until ssh.service starts.
touch "$FX/sshd-fail"
cp "$FX/ss-listen" "$FX/ss-listen.saved"
sed -i 's/("systemd",pid=1,fd=50),("sshd",pid=700,fd=3)/("systemd",pid=1,fd=50)/' "$FX/ss-listen"
e0=$(emails); run
chk "exit 0"                             "$RC" "0"
chk "no email"                           "$(new_emails)" "0"
has "logs that it reused the sshd values" "$OUT" "sshd -T failed"
rm -f "$FX/sshd-fail"; mv "$FX/ss-listen.saved" "$FX/ss-listen"
# sshd -T that answers but prints none of the watched keys: that is a real
# change (reported once), and it must not poison the cache the next failure uses.
cp "$FX/sshd-T" "$FX/sshd-T.saved"; echo 'port 22' > "$FX/sshd-T"
e0=$(emails); run
chk "watched sshd keys gone: one email"  "$(new_emails)" "1"
has "reported as removals"               "$TXT" "- sshd permitrootlogin prohibit-password"
run --accept
touch "$FX/sshd-fail"
e0=$(emails); run
chk "then sshd -T fails: no email"       "$(new_emails)" "0"
chk "no empty line in the baseline"      "$(grep -c '^$' "$BASE")" "0"
rm -f "$FX/sshd-fail"; mv "$FX/sshd-T.saved" "$FX/sshd-T"; run --accept

echo "K. a baseline that vanishes after install is itself reported"
mv "$BASE" "$WORK/baseline.saved"
e0=$(emails); run
chk "one email"                          "$(new_emails)" "1"
has "says the baseline disappeared"      "$TXT" "desapareció la línea base"
chk "baseline recreated"                 "$(yn test -s "$BASE")" "y"
e0=$(emails); run
chk "then quiet"                         "$(new_emails)" "0"

echo "L. collectors tolerate missing commands"
OUT="$(INTEGRITY_STATE_DIR="$WORK/state-l" INTEGRITY_CMD_SS=/nonexistent/ss INTEGRITY_CMD_SYSTEMCTL=/nonexistent/systemctl \
       INTEGRITY_CMD_DPKG=/nonexistent/dpkg INTEGRITY_CMD_SSHD=/nonexistent/sshd INTEGRITY_PROC_DIR=/nonexistent/proc \
       bash "$SCRIPT" 2>&1)"; RC=$?
chk "exit 0"                             "$RC" "0"
has "baseline created"                   "$OUT" "baseline created"
has "says what is missing"               "$OUT" "not available"
BL="$(cat "$WORK/state-l/baseline" 2>/dev/null)"
hasline "still watches accounts"         "$BL" "account uid0 root"
has "still watches sudoers"              "$BL" "sudoers /etc/sudoers "
hasnt "no listen lines without ss"       "$BL" "listen "

echo "M. SUID/SGID binaries that no package owns (Linux only)"
: > "$WORK/.suidprobe"; chmod u+s "$WORK/.suidprobe" 2>/dev/null
if [[ -u "$WORK/.suidprobe" ]]; then
  mkdir -p "$R/usr/bin" "$R/tmp/.x"
  printf 'sudo\n' > "$R/usr/bin/sudo"; chmod 4755 "$R/usr/bin/sudo"
  printf 'evil\n' > "$R/tmp/.x/rootsh"; chmod 4755 "$R/tmp/.x/rootsh"
  e0=$(emails); run
  chk "one email"                        "$(new_emails)" "1"
  has "category"                         "$TXT" "suid_unpackaged"
  has "names the binary"                 "$TXT" "/tmp/.x/rootsh"
  hasnt "a packaged SUID is not reported" "$TXT" "/usr/bin/sudo"
  run --accept
else
  skipped "M. SUID detection" "this filesystem has no setuid bits (NTFS)"
fi

echo "N. dpkg -S lookups escape glob characters (unit names such as ...\\x2d...)"
BS_UNIT='/usr/lib/systemd/system/system-systemd\x2dcryptsetup.slice'
( : > "$R$BS_UNIT" ) 2>/dev/null
if [[ "$(find "$R/usr/lib/systemd/system" -maxdepth 1 -name 'system-systemd\\x2dcryptsetup.slice' 2>/dev/null | grep -c '')" == "1" ]]; then
  printf '%s\n' "$BS_UNIT" >> "$FX/dpkg-owned"
  run --show
  hasnt "an owned unit with a backslash is not 'unpackaged'" "$OUT" "x2dcryptsetup"
else
  skipped "N. dpkg escaping" "this filesystem cannot hold a backslash in a file name"
fi

echo "O. state files are private (Linux only)"
( umask 077; : > "$WORK/.permprobe" )
if [[ "$(stat -c %a "$WORK/.permprobe" 2>/dev/null)" == "600" ]]; then
  chk "state dir is 700"                 "$(stat -c %a "$WORK/state")" "700"
  chk "baseline is 600"                  "$(stat -c %a "$BASE")" "600"
else
  skipped "O. permissions" "this filesystem does not keep POSIX modes"
fi

echo "Q. what reaches the journal goes through logger with the tricigo-integrity tag"
SYS="$(cat "$WORK/syslog" 2>/dev/null)"
has "tagged: baseline created"           "$SYS" "tricigo-integrity: baseline created"
has "tagged: alert sent"                 "$SYS" "tricigo-integrity: ALERT SENT"
has "tagged: failed delivery"            "$SYS" "tricigo-integrity: ALERT NOT DELIVERED"
has "tagged: accepted change"            "$SYS" "tricigo-integrity: baseline accepted"
chk "every line carries the tag"         "$(grep -vc '^tricigo-integrity: ' <<<"$SYS")" "0"

echo "R. control characters never reach the snapshot, the journal or the email"
# A process name is text an intruder fully controls; ESC[2J clears a terminal.
ESC=$'\033'
echo "0      0        10.0.0.5:55000   198.51.100.7:443  users:((\"ev${ESC}[2Jil\",pid=8888,fd=4))" >> "$FX/ss-established"
e0=$(emails); run
chk "one email"                          "$(new_emails)" "1"
has "the name, neutralized"              "$TXT" "ev?[2Jil"
hasnt "no ESC in the email"              "$TXT" "$ESC"
hasnt "no ESC in the output"             "$OUT" "$ESC"
hasnt "no ESC in the journal"            "$(cat "$WORK/syslog" 2>/dev/null)" "$ESC"
hasnt "no ESC in the state"              "$(cat "$WORK"/state/* 2>/dev/null)" "$ESC"
sed -i '/pid=8888/d' "$FX/ss-established"; run --accept

echo "P. nothing secret ever leaves the box (all emails, all logs)"
SENT="$(cat "$MOCK/attempts.jsonl" 2>/dev/null)"; LOGS="$(cat "$ALL_OUT" "$WORK/syslog" 2>/dev/null)"
secret_names=("the shadow hash" "the owner's key body" "the intruder's key body" "the Resend key" "an unrelated config value (D7 token)")
secret_values=(SECRETHASH "$BODY_OWNER" "$BODY_INTRUDER" re_test_must_never_leak d7_secret_must_never_leak)
for i in "${!secret_values[@]}"; do
  hasnt "emails never carry ${secret_names[$i]}" "$SENT" "${secret_values[$i]}"
  hasnt "logs never carry ${secret_names[$i]}"   "$LOGS" "${secret_values[$i]}"
done

echo; echo "===== $pass passed · $fail failed · $skip skipped ====="
[[ "$fail" == "0" ]]
