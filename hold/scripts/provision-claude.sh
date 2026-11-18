#!/bin/sh
# belay: set up Claude Code hooks on this machine so sessions started from belay report their
# conversation id (for --resume) and their activity (busy / idle / needs attention).
# Self-contained and idempotent: safe to run on every start, locally or piped over ssh:
#   sh provision-claude.sh                      # local
#   ssh host 'sh -s' < provision-claude.sh      # remote
# Prints nothing when everything is already in place.
set -u
HOOK_DIR="$HOME/.belay"
HOOK="$HOOK_DIR/claude-hook.sh"
SETTINGS="$HOME/.claude/settings.json"
EVENTS="SessionStart SessionEnd UserPromptSubmit PreToolUse Stop Notification"
mkdir -p "$HOOK_DIR" "$HOME/.claude" 2>/dev/null || exit 0

cat > "$HOOK.tmp" <<'HOOK'
#!/bin/sh
# belay Claude Code hook. Forwards the hook payload (stdin) to the belay session this
# terminal belongs to. Silent and harmless when not running under belay.
[ -n "${BELAY_SESSION:-}" ] && [ -n "${BELAY_URL:-}" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
curl -s -m 3 -X POST "$BELAY_URL/api/hook/claude?belay=$BELAY_SESSION" \
  -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1
exit 0
HOOK
if cmp -s "$HOOK.tmp" "$HOOK" 2>/dev/null; then rm -f "$HOOK.tmp"; else mv "$HOOK.tmp" "$HOOK"; fi
chmod +x "$HOOK" 2>/dev/null

# On a Mac without the command line tools, /usr/bin/python3 is only a stub that asks to install them.
has_python() {
  command -v python3 >/dev/null 2>&1 || return 1
  [ "$(uname -s)" = Darwin ] && [ "$(command -v python3)" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1 && return 1
  return 0
}
if has_python; then
python3 - "$SETTINGS" "$HOOK" $EVENTS <<'PY'
import json, os, sys
path, hook, *events = sys.argv[1:]
try:
    with open(path) as f: s = json.load(f)
except FileNotFoundError:
    s = {}
except Exception as e:
    print(f"belay: cannot parse {path}: {e}; hooks not installed", file=sys.stderr); sys.exit(0)
hooks = s.setdefault("hooks", {})
changed = False
for ev in events:
    arr = hooks.setdefault(ev, [])
    if not any(h.get("command", "") == hook for e in arr for h in e.get("hooks", [])):
        arr.append({"hooks": [{"type": "command", "command": hook}]}); changed = True
if changed:
    tmp = path + ".tmp"
    with open(tmp, "w") as f: json.dump(s, f, indent=2); f.write("\n")
    os.replace(tmp, path)
    print("belay: Claude Code hooks installed in " + path)
PY
elif command -v node >/dev/null 2>&1; then
node -e '
const fs = require("fs"); const [path, hook, ...events] = process.argv.slice(1);
let s = {}; try { s = JSON.parse(fs.readFileSync(path, "utf8")); } catch (e) { if (e.code !== "ENOENT") { console.error("belay: cannot parse " + path + ": " + e.message + "; hooks not installed"); process.exit(0); } }
s.hooks ||= {}; let changed = false;
for (const ev of events) { const arr = (s.hooks[ev] ||= []); if (!arr.some((e) => (e.hooks || []).some((h) => String(h.command || "") === hook))) { arr.push({ hooks: [{ type: "command", command: hook }] }); changed = true; } }
if (changed) { fs.writeFileSync(path + ".tmp", JSON.stringify(s, null, 2) + "\n"); fs.renameSync(path + ".tmp", path); console.log("belay: Claude Code hooks installed in " + path); }
' "$SETTINGS" "$HOOK" $EVENTS
else
  echo "belay: python3 or node is needed to edit $SETTINGS; hooks not installed" >&2
fi
exit 0
