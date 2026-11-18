#!/bin/sh
# belay: set up an opencode plugin on this machine so sessions started from belay report their
# conversation id (for `opencode --session`) and their activity (busy / idle / needs attention).
# Self-contained and idempotent, locally or over ssh:
#   sh provision-opencode.sh                      # local
#   ssh host 'sh -s' < provision-opencode.sh      # remote
# Prints nothing when everything is already in place.
set -u
PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugin"
PLUGIN="$PLUGIN_DIR/belay.js"
mkdir -p "$PLUGIN_DIR" 2>/dev/null || exit 0

cat > "$PLUGIN.tmp" <<'PLUGIN'
// belay opencode plugin, written by belay's provision-opencode.sh. Tells the belay session this
// terminal belongs to which conversation is open (so a relaunch resumes it) and whether opencode
// is working, idle or waiting for you, as Claude Code's hooks do. Does nothing outside belay.
export const BelayPlugin = async () => {
  const sid = process.env.BELAY_SESSION, url = process.env.BELAY_URL;
  if (!sid || !url) return {};
  const post = (sessionId, event) => {
    fetch(`${url}/api/hook/opencode?belay=${encodeURIComponent(sid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, hook_event_name: event }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  };
  // Subagents run in child sessions; they are not the conversation to resume.
  const children = new Set();
  post('', 'SessionStart');
  return {
    event: async ({ event }) => {
      const p = event.properties || {};
      if (event.type === 'session.created' || event.type === 'session.updated') {
        if (p.info?.parentID) children.add(p.info.id);
        return;
      }
      const id = p.sessionID;
      if (!id || children.has(id)) return;
      switch (event.type) {
        case 'session.status': post(id, p.status?.type === 'idle' ? 'Stop' : 'UserPromptSubmit'); break;
        case 'permission.asked': case 'permission.updated': case 'question.asked': post(id, 'PermissionRequest'); break;
        case 'permission.replied': case 'question.replied': case 'question.rejected': post(id, 'PostToolUse'); break;
        default: break;
      }
    },
  };
};
PLUGIN
if cmp -s "$PLUGIN.tmp" "$PLUGIN" 2>/dev/null; then rm -f "$PLUGIN.tmp"; else mv "$PLUGIN.tmp" "$PLUGIN"; echo "belay: opencode plugin installed in $PLUGIN"; fi
exit 0
