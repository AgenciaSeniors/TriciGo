#!/bin/bash
# ============================================================
# TriciGo — VPS integrity alarm (intrusion tripwire). v1 (2026-09-25).
#
# WHY THIS EXISTS
# ------------------------------------------------------------
# The production VPS (Ubuntu 24.04, root login key-only) was compromised for
# about five months before anyone noticed. What the intruder left behind:
#   * a gsocket backdoor installed as the systemd unit `defunct.service`, its
#     process renamed to pass for a kernel thread (`[netns]`) and its
#     executable deleted from disk;
#   * their SSH keys in the authorized_keys of ~38 accounts, including hidden
#     .ssh dirs of nologin accounts;
#   * 44 NOPASSWD files in /etc/sudoers.d;
#   * system accounts given /bin/bash and passwords;
#   * MariaDB superusers, and repeated log wiping.
# Nothing told the owner. This script is the tripwire that should have: every
# 5 minutes it takes a snapshot of what an intruder changes to stay in, diffs
# it against an approved baseline and emails the owner when something moved.
#
# DESIGN RULES
#   * Alerts go straight to Resend over HTTPS — no database and no Edge
#     Function in the path (same rule as ops/supabase-watchdog).
#   * The config is PARSED, never sourced (see load_kv).
#   * Nothing secret leaves the box: account names instead of password hashes,
#     key fingerprints instead of key bodies, sha256 instead of file contents,
#     process names instead of IPs. Config values are never printed.
#   * No PIDs, counters or timestamps in the snapshot: an unchanged box gives a
#     byte-identical snapshot, so every difference means something changed.
#
# WHAT IT WATCHES — one fact per line, "<category> <details>":
#   ssh_key, ssh_keyfile  every account's authorized_keys (+ /root): key
#                         fingerprints, and a hash of the file (options such as
#                         command="..." do not change a fingerprint)
#   sudoers               /etc/sudoers and every file in /etc/sudoers.d
#   account               uid 0, login shells, sudo/root/adm/wheel members,
#                         usable or empty passwords — names only
#   unit, unit_unpackaged enabled units, everything under /etc/systemd/system,
#                         and unit files under /usr/lib|/lib no package owns
#   cron                  system and user crontabs, cron.{hourly..yearly}
#   boot                  rc.local, ld.so.preload, shell init files, PAM, motd
#                         scripts, apt hooks, /etc/hosts, effective sshd settings
#   listen                listening sockets (proto, addr:port, process names)
#   proc                  processes running from /tmp, /var/tmp, /dev/shm or a
#                         hidden dir, deleted or memfd executables, and userland
#                         processes posing as kernel threads ("[netns]")
#   outbound              names of processes holding outbound TCP connections
#   suid_unpackaged       SUID/SGID files on / that no package owns
#
# HOW IT DECIDES (the README has the long version)
#   * listen, proc and outbound are RUNTIME categories and work as allow-lists:
#     a new entry alerts, one that goes away does not (services restart,
#     connections close). --accept adds to them and never removes.
#   * Every other category is a CONFIG category: additions AND removals alert.
#   * One email per new change: a change already emailed is not re-sent while
#     it persists. Back at the baseline, that memory is cleared, so if the same
#     change comes back it is emailed again. A failed send records nothing, so
#     the next run retries it.
#
# Usage:
#   integrity-check.sh             one check (what the timer runs)
#   integrity-check.sh --show      print the current difference; changes nothing
#   integrity-check.sh --accept    approve the current state as the new baseline
#   integrity-check.sh --selftest  send a real test email; exit 0 only if accepted
#
# Exit codes: 0 ok · 1 an email could not be delivered (or the selftest failed)
#             · 2 cannot run (config, permissions, usage).
#
# Config (root:root 600, shared with the Supabase watchdog): /etc/tricigo/supabase-health.env
# State  (root:root 700): /var/lib/tricigo/integrity/
# Install: see ops/vps-integrity/README.md
# ============================================================
set -uo pipefail
export LC_ALL=C
umask 077
shopt -s nullglob dotglob

usage() {
  cat <<'USAGE'
Usage: integrity-check.sh [--show | --accept | --selftest]
  (no option)  one check: snapshot, diff against the baseline, email on change
  --show       print the current difference against the baseline; changes nothing
  --accept     approve the current state as the new baseline
  --selftest   send a real test email; exit 0 only if Resend accepted it
USAGE
}

MODE=check
case "${1:-}" in
  "")         ;;
  --show)     MODE=show ;;
  --accept)   MODE=accept ;;
  --selftest) MODE=selftest ;;
  -h|--help)  usage; exit 0 ;;
  *)          usage >&2; exit 2 ;;
esac

# Everything is overridable so the test suite can run the real script against a
# fixture filesystem, fake commands and a mock Resend. Production uses defaults.
CONFIG_FILE="${INTEGRITY_CONFIG:-/etc/tricigo/supabase-health.env}"
STATE_DIR="${INTEGRITY_STATE_DIR:-/var/lib/tricigo/integrity}"
ROOT="${INTEGRITY_ROOT:-}"; ROOT="${ROOT%/}"
PROC_DIR="${INTEGRITY_PROC_DIR:-$ROOT/proc}"
SS="${INTEGRITY_CMD_SS:-ss}"
SYSTEMCTL="${INTEGRITY_CMD_SYSTEMCTL:-systemctl}"
DPKG="${INTEGRITY_CMD_DPKG:-dpkg}"
SSHD="${INTEGRITY_CMD_SSHD:-sshd}"
SSH_KEYGEN="${INTEGRITY_CMD_SSH_KEYGEN:-ssh-keygen}"

TAG="tricigo-integrity"
SUBJECT="TriciGo VPS — cambio sospechoso detectado"
INSTALLED_PATH="/etc/tricigo/integrity-check.sh"   # what the email tells the owner to run
RUNTIME_CATS=" listen proc outbound "

BASELINE="$STATE_DIR/baseline"
NOTIFIED="$STATE_DIR/notified"                 # diff lines already emailed
RUNTIME_ALERTED="$STATE_DIR/runtime-alerted"   # runtime additions emailed since the last --accept
ALERT_STATE="$STATE_DIR/alert.state"           # hash + time of the last alert (informative)
INSTALLED_MARK="$STATE_DIR/installed-at"
VANISHED_MARK="$STATE_DIR/baseline-vanished"
SSHD_CACHE="$STATE_DIR/sshd-T.cache"

log()  { logger -t "$TAG" -- "$*" 2>/dev/null || true; printf '%s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

HOST="$(hostname 2>/dev/null || uname -n 2>/dev/null)"; HOST="${HOST//$'\r'/}"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ -z "$ROOT" && "$(id -u 2>/dev/null)" != "0" ]]; then
  log "must run as root: the snapshot reads /etc/shadow, every home's .ssh and every /proc/<pid>/exe"
  exit 2
fi

TMPD="$(mktemp -d 2>/dev/null)" || { log "cannot create a temp dir — exiting"; exit 2; }
trap 'rm -rf "$TMPD"' EXIT

# ── config ────────────────────────────────────────────────
# Shared with the Supabase watchdog; only these keys are read, the rest is
# ignored. The file is PARSED, never sourced: a sourced env file turns
#   ALERT_EMAIL_TO=a@x.com, b@x.com
# into the command prefix `ALERT_EMAIL_TO=a@x.com b@x.com`, so the variable is
# never set and every alert is skipped in silence (found by the watchdog's test
# suite). Parsing also means a typo in the config cannot execute anything as
# root. Unquoted, quoted, spaced and CRLF values all work.
CONFIG_KEYS=" RESEND_API_KEY RESEND_API_URL ALERT_EMAIL_TO ALERT_EMAIL_FROM "
STATE_KEYS=" alert_hash alert_at alert_lines "
ENV_RESEND_API_URL="${RESEND_API_URL:-}"   # the environment may point Resend elsewhere (tests)
RESEND_API_KEY=""; RESEND_API_URL=""; ALERT_EMAIL_TO=""; ALERT_EMAIL_FROM=""

load_kv() {   # $1 = file, $2 = whitespace-delimited whitelist
  local file="$1" allow="$2" line key val
  [[ -r "$file" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; val="${line#*=}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [[ "$allow" == *" $key "* ]] || continue          # ignore anything unknown
    val="${val#"${val%%[![:space:]]*}"}"               # ltrim
    val="${val%"${val##*[![:space:]]}"}"               # rtrim
    if [[ ${#val} -ge 2 && ( ( "$val" == \"*\" ) || ( "$val" == \'*\' ) ) ]]; then
      val="${val:1:${#val}-2}"
    fi
    printf -v "$key" '%s' "$val"
  done < "$file"
  return 0
}

load_config() {
  load_kv "$CONFIG_FILE" "$CONFIG_KEYS" || return 1
  RESEND_API_URL="${ENV_RESEND_API_URL:-${RESEND_API_URL:-https://api.resend.com/emails}}"
  ALERT_EMAIL_FROM="${ALERT_EMAIL_FROM:-noreply@tricigo.com}"
  return 0
}
have_channel() { [[ -n "$RESEND_API_KEY" && -n "$ALERT_EMAIL_TO" ]]; }

# ── state ─────────────────────────────────────────────────
ensure_state_dir() {
  mkdir -p "$STATE_DIR" 2>/dev/null; chmod 700 "$STATE_DIR" 2>/dev/null
  if [[ ! -d "$STATE_DIR" || ! -w "$STATE_DIR" ]]; then
    log "state: cannot write $STATE_DIR — exiting"; return 1
  fi
}
take_lock() {   # a manual --accept and a timer run must not interleave
  have flock || return 0
  # The braces matter: `exec 9>f 2>/dev/null` would silence stderr for good.
  { exec 9>"$STATE_DIR/.lock"; } 2>/dev/null || return 0
  if ! flock -w 120 9; then
    log "another integrity-check run still holds the lock — skipping this one"; exit 0
  fi
}
write_atomic() {   # $1 = source file, $2 = destination (rename in the same dir)
  cat "$1" > "$2.tmp.$$" && mv -f "$2.tmp.$$" "$2"
}
count() { local n; n="$(grep -c '' "$1" 2>/dev/null)"; printf '%s' "${n:-0}"; }

# ── helpers ───────────────────────────────────────────────
H=""
hash_file() {   # $1 = path -> $H (sha256, or "unreadable")
  H="unreadable"
  if [[ -f "$1" && -r "$1" ]]; then
    local out
    out="$(sha256sum < "$1" 2>/dev/null)" && H="${out%% *}"
  fi
}
CLEAN=""
clean() { CLEAN="${1//[[:cntrl:]]/?}"; }   # one fact per line, whatever the file name

# Escapes for a JSON string. Newlines become the two-character sequence \n
# instead of being deleted: a human reads this body, possibly at 5 a.m.
json_escape() {
  printf '%s' "$1" \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    | tr -d '\000-\011\013-\037' \
    | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/\\n/g'
}

# ── collectors ────────────────────────────────────────────
# Each prints "<category> <details>" lines and tolerates a missing file or
# command. A collector that cannot run prints nothing, so its lines vanish from
# the snapshot — which a config category then reports as a change. That is on
# purpose: an alarm that suddenly cannot see something has to say so.

hash_paths() {   # $1 = category, then paths (globs already expanded)
  local cat="$1" f; shift
  for f in "$@"; do
    [[ -e "$f" || -L "$f" ]] || continue
    [[ -d "$f" ]] && continue
    hash_file "$f"; clean "${f#"$ROOT"}"
    printf '%s %s %s\n' "$cat" "$CLEAN" "$H"
  done
}

pw_kind() {   # $1 = password field, $2 = user. Prints a NAME, never the field.
  case "$1" in
    x|'!'*|'*'*) ;;
    "") printf 'account empty_password %s\n' "$2" ;;
    *)  printf 'account password %s\n' "$2" ;;
  esac
}

HOMES=()
collect_accounts() {
  local -A watch_gid=()
  local -a members=()
  local f name pw uid gid gecos home shell m g
  HOMES=()
  f="$ROOT/etc/group"
  if [[ -r "$f" ]]; then
    while IFS=: read -r name pw gid m _ || [[ -n "$name" ]]; do
      case "$name" in sudo|root|adm|wheel) ;; *) continue ;; esac
      [[ -n "$gid" ]] && watch_gid["$gid"]="$name"
      IFS=',' read -ra members <<< "$m"
      for m in "${members[@]}"; do [[ -n "$m" ]] && printf 'account group %s %s\n' "$name" "$m"; done
    done < "$f"
  else
    log "$f not readable — group membership not collected"
  fi
  f="$ROOT/etc/passwd"
  if [[ -r "$f" ]]; then
    while IFS=: read -r name pw uid gid gecos home shell || [[ -n "$name" ]]; do
      [[ -z "$name" || "$name" == [#+-]* ]] && continue
      [[ "$uid" == "0" ]] && printf 'account uid0 %s\n' "$name"
      case "${shell##*/}" in
        nologin|false|sync) ;;
        *) printf 'account shell %s %s\n' "$name" "${shell:-/bin/sh}" ;;
      esac
      g="${gid:-none}"
      [[ -n "${watch_gid[$g]:-}" ]] && printf 'account group %s %s\n' "${watch_gid[$g]}" "$name"
      pw_kind "$pw" "$name"   # a hash in /etc/passwd itself bypasses /etc/shadow
      [[ -n "$home" ]] && HOMES+=("$name"$'\t'"$home")
    done < "$f"
  else
    log "$f not readable — accounts not collected"
  fi
  f="$ROOT/etc/shadow"
  if [[ -r "$f" ]]; then
    while IFS=: read -r name pw _ || [[ -n "$name" ]]; do
      [[ -z "$name" || "$name" == [#+-]* ]] && continue
      pw_kind "$pw" "$name"
    done < "$f"
  else
    log "$f not readable — password state not collected"
  fi
}

collect_ssh_keys() {   # needs HOMES from collect_accounts
  local -A seen=()
  local entry user home file path key bits fp rest kg=1
  if ! have "$SSH_KEYGEN"; then
    log "$SSH_KEYGEN not available — key fingerprints not collected (the files are still hashed)"; kg=0
  fi
  # "plus /root": root's home is normally /root already, and then this is a no-op.
  for entry in "${HOMES[@]}" $'root\t/root'; do
    user="${entry%%$'\t'*}"; home="${entry#*$'\t'}"
    for file in authorized_keys authorized_keys2; do
      path="${home%/}/.ssh/$file"
      key="$user|$path"
      [[ -n "${seen[$key]:-}" ]] && continue
      seen[$key]=1
      [[ -e "$ROOT$path" || -L "$ROOT$path" ]] || continue
      hash_file "$ROOT$path"; clean "$path"
      printf 'ssh_keyfile %s %s %s\n' "$user" "$CLEAN" "$H"
      (( kg )) || continue
      # "<bits> <fingerprint> <comment> (<TYPE>)" — the key body never leaves.
      while read -r bits fp rest; do
        [[ "$fp" == *:* ]] || continue
        printf 'ssh_key %s %s %s\n' "$user" "$fp" "$rest"
      done < <("$SSH_KEYGEN" -E sha256 -lf "$ROOT$path" 2>/dev/null)
    done
  done
}

collect_units() {
  local f
  if have "$SYSTEMCTL"; then
    "$SYSTEMCTL" list-unit-files --state=enabled --no-legend --no-pager 2>/dev/null \
      | awk 'NF { print "unit enabled " $1 }'
  else
    log "$SYSTEMCTL not available — enabled units not collected"
  fi
  [[ -d "$ROOT/etc/systemd/system" ]] || return 0
  # Files are hashed; symlinks (enablement, masks) are recorded by target, so a
  # package upgrade of the unit they point to does not read as a change here.
  while IFS= read -r -d '' f; do
    clean "${f#"$ROOT"}"
    if [[ -L "$f" ]]; then
      printf 'unit link %s -> %s\n' "$CLEAN" "$(readlink "$f")"
    else
      hash_file "$f"; printf 'unit file %s %s\n' "$CLEAN" "$H"
    fi
  done < <(find "$ROOT/etc/systemd/system" -mindepth 1 \( -type f -o -type l \) -print0 2>/dev/null)
}

ALIAS=""
usr_alias() {   # the other spelling of a path on a usr-merged system
  case "$1" in
    /usr/bin/*|/usr/sbin/*|/usr/lib/*|/usr/lib32/*|/usr/lib64/*|/usr/libx32/*) ALIAS="${1#/usr}" ;;
    /bin/*|/sbin/*|/lib/*|/lib32/*|/lib64/*|/libx32/*) ALIAS="/usr$1" ;;
    *) ALIAS="" ;;
  esac
}

# Prints, one per line, the given paths that NO dpkg package owns. Ubuntu 24.04
# is usr-merged (/lib -> usr/lib) but dpkg still records many files under their
# old /lib or /bin spelling, so each path is looked up under both. dpkg -S takes
# glob patterns (\ * ? [ are special), so names are escaped first: unescaped,
# the `\x` in system-systemd\x2dcryptsetup.slice reads as `x` and a packaged
# unit looks unpackaged. Returns 1 when dpkg cannot answer.
dpkg_unowned() {
  (( $# )) || return 0
  if ! have "$DPKG"; then log "$DPKG not available — cannot tell packaged files from the rest"; return 1; fi
  local -A owned=()
  local -a raw=() q=()
  local p out rc line
  for p in "$@"; do
    raw+=("$p"); usr_alias "$p"; [[ -n "$ALIAS" ]] && raw+=("$ALIAS")
  done
  mapfile -t q < <(printf '%s\n' "${raw[@]}" | sed 's/[][\\*?]/\\&/g')
  out="$("$DPKG" -S "${q[@]}" 2>/dev/null)"; rc=$?
  if (( rc > 1 )); then log "dpkg -S failed (exit $rc) — cannot tell packaged files from the rest"; return 1; fi
  while IFS= read -r line; do
    case "$line" in "diversion by "*|"local diversion"*) continue ;; esac
    [[ "$line" == *": /"* ]] && owned["${line#*: }"]=1
  done <<< "$out"
  for p in "$@"; do
    [[ -n "${owned[$p]:-}" ]] && continue
    usr_alias "$p"
    [[ -n "$ALIAS" && -n "${owned[$ALIAS]:-}" ]] && continue
    printf '%s\n' "$p"
  done
}

emit_unowned() {   # $1 = category, then paths as seen on the real system
  local cat="$1" p; shift
  (( $# )) || return 0
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    clean "$p"
    if [[ -L "$ROOT$p" ]]; then
      printf '%s %s -> %s\n' "$cat" "$CLEAN" "$(readlink "$ROOT$p")"
    else
      hash_file "$ROOT$p"; printf '%s %s %s\n' "$cat" "$CLEAN" "$H"
    fi
  done < <(dpkg_unowned "$@")
}

collect_unpackaged_units() {
  local usr="$ROOT/usr/lib/systemd/system" lib="$ROOT/lib/systemd/system" d f
  local -a cand=()
  for d in "$usr" "$lib"; do
    [[ -d "$d" ]] || continue
    # usr-merged: /lib is a symlink to usr/lib — the same files, scan them once.
    [[ "$d" == "$lib" && -d "$usr" && "$lib" -ef "$usr" ]] && continue
    while IFS= read -r -d '' f; do cand+=("${f#"$ROOT"}"); done \
      < <(find "$d" -mindepth 1 \( -type f -o -type l \) -print0 2>/dev/null)
  done
  emit_unowned unit_unpackaged "${cand[@]}"
}

collect_suid() {   # the slowest collector: walks the whole root filesystem
  local f
  local -a cand=()
  while IFS= read -r -d '' f; do cand+=("${f#"$ROOT"}"); done \
    < <(find "$ROOT/" -xdev -type f -perm /6000 -print0 2>/dev/null)
  emit_unowned suid_unpackaged "${cand[@]}"
}

collect_cron() {
  hash_paths cron "$ROOT/etc/crontab" "$ROOT/etc/anacrontab" "$ROOT"/etc/cron.d/* \
    "$ROOT"/etc/cron.hourly/* "$ROOT"/etc/cron.daily/* "$ROOT"/etc/cron.weekly/* \
    "$ROOT"/etc/cron.monthly/* "$ROOT"/etc/cron.yearly/* "$ROOT"/var/spool/cron/crontabs/*
}

# `sshd -T` prints the EFFECTIVE settings (includes, Match defaults) — what an
# edit to sshd_config.d would really change. It fails while /run/sshd does not
# exist, which on a socket-activated sshd is the case after every reboot until
# the first SSH login; then the last good values are reused instead of reading
# as "settings removed".
collect_sshd() {
  local out
  if ! have "$SSHD"; then log "$SSHD not available — effective sshd settings not collected"; return; fi
  if out="$("$SSHD" -T 2>/dev/null)" && [[ -n "$out" ]]; then
    out="$(awk 'BEGIN { split("passwordauthentication permitrootlogin allowusers pubkeyauthentication authorizedkeysfile", k, " ")
                        for (i in k) want[k[i]] = 1 }
                { key = tolower($1) }
                key in want { $1 = ""; sub(/^ +/, ""); print "boot sshd " key " " $0 }' <<< "$out")"
    # Every successful answer becomes the cache — also one without any watched
    # key, cached as empty — so a later failure replays the LAST answer, never an
    # older one and never a blank line.
    if [[ -n "$out" ]]; then printf '%s\n' "$out"; fi
    if [[ "$MODE" == check || "$MODE" == accept ]] && [[ -d "$STATE_DIR" ]]; then
      if [[ -n "$out" ]]; then printf '%s\n' "$out"; else :; fi > "$SSHD_CACHE.tmp.$$" \
        && mv -f "$SSHD_CACHE.tmp.$$" "$SSHD_CACHE"
    fi
  elif [[ -f "$SSHD_CACHE" ]]; then
    log "sshd -T failed — reusing the last good values (normal before the first SSH login after a reboot)"
    cat "$SSHD_CACHE"
  else
    log "sshd -T failed and there are no cached values — effective sshd settings not collected"
  fi
}

collect_boot() {
  # ld.so.preload is normally ABSENT: its mere existence is the finding.
  hash_paths boot "$ROOT/etc/rc.local" "$ROOT/etc/ld.so.preload" "$ROOT/etc/ld.so.conf" \
    "$ROOT"/etc/ld.so.conf.d/* "$ROOT/etc/environment" "$ROOT/etc/profile" "$ROOT"/etc/profile.d/* \
    "$ROOT/etc/bash.bashrc" "$ROOT/root/.bashrc" "$ROOT/root/.profile" "$ROOT/root/.bash_profile" \
    "$ROOT/root/.bash_logout" "$ROOT/root/.ssh/rc" "$ROOT/etc/ssh/sshrc" "$ROOT/etc/ssh/sshd_config" \
    "$ROOT"/etc/ssh/sshd_config.d/* "$ROOT"/etc/pam.d/* "$ROOT"/etc/update-motd.d/* \
    "$ROOT"/etc/apt/apt.conf.d/* "$ROOT/etc/hosts"
  collect_sshd
}

# Listening sockets and outbound connections, from ss. Lines look like
#   tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6),...)
# and process names can contain spaces ("next-server (v1"), so the process part
# is cut off first and the two address columns are the last two fields before
# it. One line per process name: with socket-activated sshd, :22 is held by
# "systemd" alone after a reboot and by "sshd" + "systemd" after the first
# login, and that must read as an entry going away (ignored), not a new one.
# An established connection whose local port is a listening port was accepted
# (inbound); anything else was opened from here (outbound).
collect_net() {
  if ! have "$SS"; then log "$SS not available — listening sockets and outbound connections not collected"; return; fi
  "$SS" -H -tulpn > "$TMPD/ss.listen" 2>/dev/null
  "$SS" -H -tnp state established > "$TMPD/ss.est" 2>/dev/null
  awk '
    function parse(line,    i, head, f, n) {
      USERS = ""; head = line
      i = index(line, "users:(")
      if (i > 0) { USERS = substr(line, i); head = substr(line, 1, i - 1) }
      sub(/^[ \t]+/, "", head); sub(/[ \t]+$/, "", head)
      n = split(head, f, /[ \t]+/)
      if (n < 2) return 0
      PROTO = f[1]; LOCAL = f[n - 1]
      PORT = LOCAL; sub(/.*:/, "", PORT)
      return 1
    }
    function names(s, out,    n, nm) {   # process names in users:((...)); duplicates
      n = 0                              # are collapsed later by sort -u
      while (match(s, /\("[^"]*"/)) {
        nm = substr(s, RSTART + 2, RLENGTH - 3)
        s = substr(s, RSTART + RLENGTH)
        out[++n] = nm
      }
      return n
    }
    FILENAME == ARGV[1] {
      if (!parse($0)) next
      if (PROTO == "udp" && PORT + 0 >= 32768) next    # ephemeral client sockets: noise
      if (PROTO == "tcp") listening[PORT] = 1
      k = names(USERS, procs)
      if (k == 0) print "listen " PROTO " " LOCAL " -"
      for (i = 1; i <= k; i++) print "listen " PROTO " " LOCAL " " procs[i]
      next
    }
    {
      if (!parse($0) || (PORT in listening)) next
      k = names(USERS, procs)
      for (i = 1; i <= k; i++) print "outbound " procs[i]
    }
  ' "$TMPD/ss.listen" "$TMPD/ss.est"
}

# Processes, from /proc/<pid>/exe (+ cmdline). Kernel threads have no readable
# exe link and are skipped; a userland process whose command line starts with
# "[" is dressing up as one — exactly what the gsocket backdoor did.
collect_proc() {
  if [[ ! -d "$PROC_DIR" ]]; then log "$PROC_DIR not available — processes not inspected"; return; fi
  local d exe path argv0 deleted where re_hidden='(^|/)\.[^/]'
  for d in "$PROC_DIR"/[0-9]*; do
    exe="$(readlink "$d/exe" 2>/dev/null)" || continue
    [[ -n "$exe" ]] || continue
    argv0=""
    if [[ -r "$d/cmdline" ]]; then IFS= read -r -d '' argv0 < "$d/cmdline" || true; fi
    path="$exe"; deleted=0
    if [[ "$path" == *" (deleted)" ]]; then path="${path% (deleted)}"; deleted=1; fi
    where=""
    case "$path" in
      /tmp/*|/var/tmp/*|/dev/shm/*) where=tmp ;;
      /memfd:*) where=memfd ;;
      *) [[ "$path" =~ $re_hidden ]] && where=hidden ;;
    esac
    clean "$path"
    case "$where" in
      memfd)  printf 'proc exe_memfd %s\n' "$CLEAN" ;;
      tmp)    if (( deleted )); then printf 'proc exe_deleted %s\n' "$CLEAN"; else printf 'proc exe_in_tmp %s\n' "$CLEAN"; fi ;;
      hidden) if (( deleted )); then printf 'proc exe_deleted %s\n' "$CLEAN"; else printf 'proc exe_in_hidden_dir %s\n' "$CLEAN"; fi ;;
    esac
    if [[ "$argv0" == \[* ]]; then
      argv0="${argv0//[^[:print:]]/}"
      printf 'proc fake_kthread %s %s\n' "$CLEAN" "${argv0:0:64}"
    fi
  done
}

SNAP_SECS=0
take_snapshot() {   # $1 = output file: sorted, unique lines
  local t0=$SECONDS
  {
    collect_accounts    # also fills HOMES for collect_ssh_keys
    collect_ssh_keys
    hash_paths sudoers "$ROOT/etc/sudoers" "$ROOT"/etc/sudoers.d/*
    collect_units
    collect_unpackaged_units
    collect_cron
    collect_boot
    collect_net
    collect_proc
    collect_suid
  } > "$1.raw"
  # File names, process names and ss/sshd output are text an intruder controls:
  # no control character (ESC sequences can rewrite a terminal) goes further
  # than this — not to the baseline, the journal or the email.
  tr '\000-\011\013-\037\177' '?' < "$1.raw" | sort -u > "$1"
  rm -f "$1.raw"
  SNAP_SECS=$(( SECONDS - t0 ))
}

# ── diff ──────────────────────────────────────────────────
# "+line" = in the current snapshot, not in the baseline; "-line" = the reverse.
# Removals from the runtime categories are dropped: they are allow-lists.
alertable_diff() {   # $1 = baseline, $2 = current
  { comm -13 "$1" "$2" | sed 's/^/+/'
    comm -23 "$1" "$2" | awk -v rt="$RUNTIME_CATS" 'index(rt, " " $1 " ") == 0 { print "-" $0 }'
  } | sort
}
runtime_additions() {   # $1 = diff file -> the runtime lines it adds, without "+"
  awk -v rt="$RUNTIME_CATS" 'substr($0, 1, 1) == "+" {
    l = substr($0, 2); c = l; sub(/ .*/, "", c)
    if (index(rt, " " c " ")) print l
  }' "$1"
}

# Groups a diff by category for the email. Lines not in $2 (the ones already
# emailed) get a "<- NUEVO" marker, but only when some lines were emailed before.
render_diff() {   # $1 = diff file, $2 = already-notified file (may not exist)
  awk -v known="$2" -v max=300 '
    BEGIN {
      n = split("ssh_key ssh_keyfile sudoers account unit unit_unpackaged cron boot listen proc outbound suid_unpackaged", ord, " ")
      for (i = 1; i <= n; i++) in_order[ord[i]] = 1
      title["ssh_key"]         = "llaves SSH autorizadas (huella)"
      title["ssh_keyfile"]     = "archivos authorized_keys (sha256)"
      title["sudoers"]         = "reglas de sudo (sha256)"
      title["account"]         = "cuentas: uid 0, shells de login, grupos con privilegios, contraseñas"
      title["unit"]            = "servicios de systemd"
      title["unit_unpackaged"] = "units de systemd que no son de ningún paquete"
      title["cron"]            = "tareas programadas (sha256)"
      title["boot"]            = "arranque, login y sshd"
      title["listen"]          = "puertos escuchando (solo altas)"
      title["proc"]            = "procesos sospechosos (solo altas)"
      title["outbound"]        = "procesos con conexiones salientes (solo altas)"
      title["suid_unpackaged"] = "binarios SUID/SGID que no son de ningún paquete"
      nk = 0
      if (known != "") while ((getline l < known) > 0) { seen[l] = 1; nk++ }
    }
    {
      sign = substr($0, 1, 1); rest = substr($0, 2)
      cat = rest; sub(/ .*/, "", cat)
      row = sign " " substr(rest, length(cat) + 2)
      if (nk > 0 && !($0 in seen)) row = row "   <- NUEVO"
      if (!(cat in rows)) { cats[++nc] = cat; rows[cat] = "" }
      if (shown < max) { rows[cat] = rows[cat] row "\n"; shown++ } else omitted++
    }
    function group(c) { printf "== %s · %s ==\n%s\n", c, (c in title ? title[c] : "otros"), rows[c] }
    END {
      for (i = 1; i <= n; i++) if (ord[i] in rows) group(ord[i])
      for (i = 1; i <= nc; i++) if (!(cats[i] in in_order)) group(cats[i])
      if (omitted) printf "... y %d líneas más: ver --show en el VPS.\n\n", omitted
    }
  ' "$1"
}

apt_last() {   # start of the last apt run: a change right after it is usually an upgrade
  local f="$ROOT/var/log/apt/history.log"
  [[ -r "$f" ]] || return 0
  grep '^Start-Date:' "$f" 2>/dev/null | tail -n 1 \
    | sed -e 's/^Start-Date:[[:space:]]*//' -e 's/[[:space:]][[:space:]]*/ /g'
}

# ── email (Resend, called directly — never through the database) ──────
SEND_HTTP=""; SEND_ERR=""
send_email() {   # $1 = subject, $2 = body. 0 when Resend answered 2xx.
  local subject="$1" body="$2" to_json="" addr
  local -a addrs=()
  SEND_HTTP="-"; SEND_ERR=""
  IFS=',' read -ra addrs <<< "$ALERT_EMAIL_TO"
  for addr in "${addrs[@]}"; do
    addr="${addr#"${addr%%[![:space:]]*}"}"; addr="${addr%"${addr##*[![:space:]]}"}"
    [[ -n "$addr" ]] || continue
    to_json="${to_json:+$to_json,}\"$(json_escape "$addr")\""
  done
  if [[ -z "$to_json" ]]; then SEND_HTTP="no-recipient"; return 1; fi
  # Key and payload go through files, not argv: argv is visible in `ps`, and a
  # long diff would not fit in one argument anyway. Relative @file names (with
  # the cd) keep this portable to Git Bash, where curl is a native binary.
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$RESEND_API_KEY" > "$TMPD/email.hdr"
  printf '{"from":"%s","to":[%s],"subject":"%s","text":"%s"}' "$(json_escape "$ALERT_EMAIL_FROM")" \
    "$to_json" "$(json_escape "$subject")" "$(json_escape "$body")" > "$TMPD/email.json"
  SEND_HTTP="$(cd "$TMPD" && curl -s -o email.resp -w '%{http_code}' --max-time 20 -X POST \
    -H @email.hdr --data-binary @email.json "$RESEND_API_URL" 2>/dev/null)"
  SEND_HTTP="${SEND_HTTP:-000}"
  rm -f "$TMPD/email.hdr"
  [[ "$SEND_HTTP" =~ ^2[0-9][0-9]$ ]] && return 0
  SEND_ERR="$(tr -d '\r\n' < "$TMPD/email.resp" 2>/dev/null | tr -cd '[:print:]' | cut -c1-200)"
  return 1
}

alert_body() {   # $1 = total lines, $2 = new lines
  local total="$1" new="$2" apt
  apt="$(apt_last)"
  printf 'Cambió algo en el VPS de TriciGo que no está en la línea base aprobada.\n\n'
  printf 'Servidor: %s\n' "$HOST"
  printf 'Hora:     %s UTC\n' "$NOW"
  if (( new == 1 && total > 1 )); then
    printf 'Cambios:  %s (1 nuevo desde el último aviso, marcado con <- NUEVO)\n' "$total"
  elif (( new < total )); then
    printf 'Cambios:  %s (%s nuevos desde el último aviso, marcados con <- NUEVO)\n' "$total" "$new"
  else
    printf 'Cambios:  %s\n' "$total"
  fi
  [[ -n "$apt" ]] && printf 'Último apt: %s — si coincide con el cambio, probablemente es una actualización de paquetes.\n' "$apt"
  printf '\n'
  render_diff "$TMPD/diff" "$NOTIFIED"
  cat <<EOF
"+" = apareció, "-" = desapareció, respecto de la línea base. Los grupos "solo
altas" (listen, proc, outbound) son listas de permitidos: lo nuevo avisa; lo que
desaparece (un servicio que se reinicia, una conexión que se cierra) no.

Qué hacer:
1. Si NO reconoces el cambio, trátalo como una intrusión: no lo aceptes, conserva
   la evidencia y sigue "Después de una intrusión real" en ops/vps-integrity/README.md.
2. Si es legítimo (una actualización de paquetes, un deploy, un cambio tuyo),
   apruébalo en el VPS:
     $INSTALLED_PATH --show     (ver la diferencia actual)
     $INSTALLED_PATH --accept   (aprobarla como nueva línea base)
   --accept también deja permitidos los puertos, procesos y conexiones salientes
   de este aviso aunque ya no estén activos.

Mientras este mismo cambio siga pendiente no se vuelve a avisar: solo llega otro
correo si aparece algo nuevo.

Alarma de integridad del VPS · journalctl -t $TAG -n 50
EOF
}

vanished_body() {
  cat <<EOF
ALERTA: desapareció la línea base de la alarma de integridad del VPS.

Servidor: $HOST
Hora:     $NOW UTC

$BASELINE no estaba, aunque la alarma ya estaba instalada (desde $(cat "$INSTALLED_MARK" 2>/dev/null)).
Se creó una línea base nueva con el estado ACTUAL del servidor, así que lo que
haya cambiado mientras faltaba ya no se puede reportar.

Si no la borraste tú, trátalo como una intrusión: borrar la línea base es la
forma de que la alarma "apruebe" un cambio sin que nadie se entere.
Para reiniciar la alarma a propósito se borra el directorio entero
($STATE_DIR), no solo ese archivo; así este aviso no se envía.

Alarma de integridad del VPS · journalctl -t $TAG -n 50
EOF
}

# ── modes ─────────────────────────────────────────────────
do_check() {
  local rc=0 total new hash l alert_hash="" alert_at="" alert_lines=""
  if ! load_config; then
    log "config: $CONFIG_FILE missing or unreadable — the integrity alarm could not tell anyone, exiting"
    return 2
  fi
  if ! have_channel; then
    log "CONFIG ERROR: no alert channel configured (RESEND_API_KEY and ALERT_EMAIL_TO in $CONFIG_FILE) — a change would reach nobody, not running"
    return 2
  fi
  ensure_state_dir || return 2
  take_lock
  take_snapshot "$TMPD/current"

  if [[ ! -f "$BASELINE" ]]; then
    write_atomic "$TMPD/current" "$BASELINE"
    rm -f "$NOTIFIED" "$ALERT_STATE" "$RUNTIME_ALERTED"
    if [[ ! -f "$INSTALLED_MARK" ]]; then
      printf '%s\n' "$NOW" > "$INSTALLED_MARK"
      log "baseline created ($(count "$BASELINE") lines) — first run, no email. Review it: $BASELINE"
      return 0
    fi
    # Installed before, baseline gone: deleting it is how a change would get
    # "approved" without anyone knowing. Recreate it, and say so.
    log "BASELINE VANISHED — $BASELINE was missing although the alarm was installed; recreated from the current state"
    printf '%s\n' "$NOW" > "$VANISHED_MARK"
  fi

  if [[ -f "$VANISHED_MARK" ]]; then
    if send_email "$SUBJECT" "$(vanished_body)"; then
      rm -f "$VANISHED_MARK"; log "ALERT SENT (baseline vanished) — resend http=$SEND_HTTP"
    else
      log "ALERT NOT DELIVERED (baseline vanished) — resend http=$SEND_HTTP${SEND_ERR:+ ($SEND_ERR)}; the next run retries"
      rc=1
    fi
  fi

  alertable_diff "$BASELINE" "$TMPD/current" > "$TMPD/diff"
  total="$(count "$TMPD/diff")"
  if (( total == 0 )); then
    if [[ -s "$NOTIFIED" || -f "$ALERT_STATE" ]]; then
      rm -f "$NOTIFIED" "$ALERT_STATE"
      log "back to baseline — the changes emailed earlier are gone; if they come back they will be emailed again"
    else
      log "ok: no changes against the baseline ($(count "$BASELINE") lines, snapshot ${SNAP_SECS}s)"
    fi
    return "$rc"
  fi

  [[ -f "$NOTIFIED" ]] || : > "$NOTIFIED"
  comm -23 "$TMPD/diff" "$NOTIFIED" > "$TMPD/new"
  new="$(count "$TMPD/new")"
  hash="$(sha256sum < "$TMPD/diff")"; hash="${hash%% *}"
  if (( new == 0 )); then
    load_kv "$ALERT_STATE" "$STATE_KEYS" || true
    log "no email: same changes as the last alert (${total} lines, diff ${hash:0:12}, emailed ${alert_at:-earlier}) — --show to see them, --accept to approve them"
    return "$rc"
  fi

  log "CHANGE DETECTED: $total line(s) differ from the baseline, $new new — diff ${hash:0:12}"
  while IFS= read -r l; do log "  $l"; done < "$TMPD/new"
  if send_email "$SUBJECT" "$(alert_body "$total" "$new")"; then
    sort -u -o "$NOTIFIED" "$NOTIFIED" "$TMPD/diff"
    { [[ -f "$RUNTIME_ALERTED" ]] && cat "$RUNTIME_ALERTED"; runtime_additions "$TMPD/diff"; } \
      | sort -u > "$TMPD/runtime-alerted"
    write_atomic "$TMPD/runtime-alerted" "$RUNTIME_ALERTED"
    printf 'alert_hash=%s\nalert_at=%s\nalert_lines=%s\n' "$hash" "$NOW" "$total" > "$TMPD/alert.state"
    write_atomic "$TMPD/alert.state" "$ALERT_STATE"
    log "ALERT SENT — resend http=$SEND_HTTP, diff ${hash:0:12}"
  else
    log "ALERT NOT DELIVERED — resend http=$SEND_HTTP${SEND_ERR:+ ($SEND_ERR)}; nothing recorded, the next run retries"
    rc=1
  fi
  return "$rc"
}

do_show() {
  take_snapshot "$TMPD/current"
  if [[ ! -f "$BASELINE" ]]; then
    echo "Todavía no hay línea base ($BASELINE): la crea la próxima ejecución normal."
    return 0
  fi
  alertable_diff "$BASELINE" "$TMPD/current" > "$TMPD/diff"
  if [[ -s "$TMPD/diff" ]]; then
    sed 's/^\(.\)/\1 /' "$TMPD/diff"
  else
    echo "sin diferencias contra la línea base ($(count "$BASELINE") líneas)"
  fi
}

do_accept() {
  local changes=0 kept l
  ensure_state_dir || return 2
  take_lock
  take_snapshot "$TMPD/current"
  # Runtime categories are allow-lists: keep what the baseline already allowed
  # and what the alerts since the last --accept reported, even if it is not
  # running right now (a connection that came and went is still "seen").
  {
    cat "$TMPD/current"
    [[ -f "$BASELINE" ]] && awk -v rt="$RUNTIME_CATS" 'index(rt, " " $1 " ")' "$BASELINE"
    [[ -f "$RUNTIME_ALERTED" ]] && cat "$RUNTIME_ALERTED"
  } | sort -u > "$TMPD/newbase"
  : > "$TMPD/diff"
  if [[ -f "$BASELINE" ]]; then
    alertable_diff "$BASELINE" "$TMPD/current" > "$TMPD/diff"
    changes="$(count "$TMPD/diff")"
    echo "Cambios que se aprueban ($changes):"
    if (( changes )); then sed 's/^\(.\)/\1 /' "$TMPD/diff"; else echo "  (ninguno)"; fi
  else
    echo "No había línea base: se crea con el estado actual."
  fi
  comm -23 "$TMPD/newbase" "$TMPD/current" > "$TMPD/kept"
  kept="$(count "$TMPD/kept")"
  if (( kept )); then
    echo "Se mantienen permitidos aunque ahora no estén activos ($kept):"
    cat "$TMPD/kept"
  fi
  write_atomic "$TMPD/newbase" "$BASELINE"
  rm -f "$NOTIFIED" "$ALERT_STATE" "$RUNTIME_ALERTED" "$VANISHED_MARK"
  [[ -f "$INSTALLED_MARK" ]] || printf '%s\n' "$NOW" > "$INSTALLED_MARK"
  log "baseline accepted by the operator: changes approved: $changes; runtime entries kept allowed though inactive: $kept; baseline lines: $(count "$BASELINE")"
  while IFS= read -r l; do log "  accepted: $l"; done < "$TMPD/diff"
  echo "Línea base aprobada: $BASELINE"
}

do_selftest() {
  local counts base_status lines
  if ! load_config; then
    log "selftest: FALLO — config $CONFIG_FILE missing or unreadable"; return 2
  fi
  take_snapshot "$TMPD/current"
  lines="$(count "$TMPD/current")"
  counts="$(awk '{ c[$1]++ } END { for (k in c) print k "=" c[k] }' "$TMPD/current" | sort | paste -sd' ' -)"
  if [[ -f "$BASELINE" ]]; then base_status="existe, $(count "$BASELINE") líneas"
  else base_status="todavía no existe (la crea la primera ejecución normal)"; fi
  log "selftest: snapshot -> $lines lines in ${SNAP_SECS}s: ${counts:-nothing}"
  log "selftest: baseline -> $base_status"
  if ! have_channel; then
    log "selftest: FALLO — ningún canal configurado (hacen falta RESEND_API_KEY y ALERT_EMAIL_TO en $CONFIG_FILE)"
    return 1
  fi
  if send_email "TriciGo VPS — PRUEBA de la alarma de integridad" "Esto es una PRUEBA de la alarma de integridad del VPS de TriciGo.
Si lees este correo, la alarma puede avisarte cuando cambie algo en el servidor.

Servidor:   $HOST
Hora:       $NOW UTC
Línea base: $base_status
Vigilando:  $lines líneas (${counts:-nada}), recorridas en ${SNAP_SECS} s

No hay que hacer nada con este correo."; then
    log "selftest: OK — Resend aceptó el envío (http=$SEND_HTTP). Confirma que te llegó."
    return 0
  fi
  # A selftest that reports success without checking is the bug it exists to
  # catch: only a 2xx from Resend counts.
  log "selftest: FALLO — Resend no aceptó el envío (http=$SEND_HTTP${SEND_ERR:+, $SEND_ERR})"
  return 1
}

case "$MODE" in
  check)    do_check ;;
  show)     do_show ;;
  accept)   do_accept ;;
  selftest) do_selftest ;;
esac
exit $?
