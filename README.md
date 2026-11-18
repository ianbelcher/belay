# Belay

My own terminal and file muxer.

- **Sessions stay open, like tmux, without the hassle of running tmux.** Close belay, lose the wifi
  or shut the lid and your sessions keep going, here and on every server you ssh into. Nothing to
  install on the servers. When you come back, belay picks up exactly where it was, with everything
  you missed.
- **Configurable workflows.** Templates say what to run and projects say where, so Claude, Codex,
  opencode, htop, k9s or any of your daily tools start with a click, on this machine or over ssh.
- **Real scrollback.** Each pane is its own xterm.js instance, so the mouse wheel, drag select, find
  and copy and paste work like a normal terminal. No copy mode. Programs that set the clipboard with
  OSC 52, such as Claude's `/copy`, reach your local clipboard.
- **Web and remote pages.** Open a web page in a tab, or a remote page loaded from the project's
  machine, such as `localhost:8080` there or `grafana.monitoring.svc.cluster.local:3000` from a pod.
  belay serves it to your browser under its own name, WebSockets included, so there is nothing to
  forward.
- **Projects, laid out like iTerm.** Projects are the top-level tabs, each with a directory and its
  own layout. Inside a project, drag tabs to split panes, resize with the splitters, maximize one
  pane, drag a tab out for a floating pane, or drop it on another project's tab to move it there.
- **Notes.** One markdown scratch pad per project down the right-hand side (Cmd+Shift+K), for ideas
  you are not ready to give the agent yet. Closing it only hides it, and it saves as you type.
- **Post-its.** A wall of notes per project for todos and loose ends, colored, grouped by dragging
  one into another, with a map of the whole wall.
- **Claude Code, Codex and opencode aware.** Their templates install hooks (a plugin for opencode)
  on the machine the agent runs on, local or remote. The tab then shows whether the agent is
  working, idle or waiting for you, and a restart resumes the conversation without you looking its
  id up. You can add provisioners of your own for other tools too.
- **Supports macOS and Linux.**
- **Command palette and rebindable keys.** Cmd+Shift+P (Ctrl+Shift+P outside macOS) lists every
  command, project, session, note and template. Every shortcut can be changed in Settings.

## Quick start

Download the app for macOS or Linux from the
[latest release](https://github.com/ianbelcher/belay/releases/latest) and open it. Sessions keep
running when it closes; it keeps its state, scrollback and the holder in `~/.belay`.

The macOS builds are not yet signed with a Developer ID or notarized by Apple: the first time, open
the app from System Settings → Privacy & Security → **Open Anyway**.

From a checkout:

```sh
cd belay
npm install            # builds the browser bundle and the holder (needs Go 1.22 or later)
npm run app            # the app, from this checkout
npm start              # or belay as a server: http://127.0.0.1:7681
npm run dist           # the app's builds for this system, in dist/
```

The app picks its port once (7681 if it is free) and a token of its own, both kept in
`~/.belay/app.json`: the port stays the same because agents on your hosts report back to it.

As a server, environment variables: `BELAY_HOST` (default `127.0.0.1`), `BELAY_PORT` (default `7681`),
`BELAY_DATA_DIR` (default `~/.belay`), `BELAY_TOKEN` (optional access token, see Security).
Only one belay runs per data directory: a second one exits instead of following every session a
second time.

A server opened in Chrome or Edge can be installed as an app of its own there: **Install app** in
the top bar (or the browser's own install option).

## Concepts

### Sessions

A session is `{ name, directory, template, variables, on-exit policy }`. The command line is
rendered from the template every time the session starts, never stored, so editing the
variables changes what the next start runs. The pane's edit dialog shows the live preview.
New sessions open as a tab in the current group (the + after a group's tabs, the palette, or the
New session form on Cmd+T, which picks any template, host and directory), and tabs can be dragged into any arrangement. Click the tab that is already
active, or the name in the pane's bar, to edit the session; right-click a tab for the rest.

The + after a group's tabs lists every template, then Notes, Post-its, File…, Web page… and
Remote page…. It, the `>_` button in a pane's bar (a shell) and the tab menu start a session next
to an existing one without the dialog:

- It runs where the project is: in its directory, on its host or here (home when the project
  has no directory). New sessions get a name like `sly-fox`, to rename as you like (a template
  with a name template of its own, such as Command, names them after what they run).
- A template that needs a value first (Command asks what to run; its menu item ends in …)
  opens the New session form on it, filled in with the project's place.
- **Duplicate** (tab menu, or the edit dialog) creates a session with the same template,
  directory and values under a free name, minus `session`, so the agent starts a new conversation.

The New session form starts from the same place: a remote project fills in its host, user and
directory.

Status is `starting`, `running`, `exited` (the process ended by itself) or `stopped` (you
stopped it). A running session keeps running when belay closes or restarts; belay picks it up
again where it was. One that is gone when belay comes back (its machine restarted) is started
again if it was meant to be running.

On-exit policy, per template with a per-session override:

| policy    | behavior                                                         |
|-----------|------------------------------------------------------------------|
| `hold`    | keep the pane, show the exit code and a Restart button (default) |
| `restart` | relaunch automatically with a backoff from 1s to 30s             |
| `close`   | delete the session                                               |

### Templates

A template is what to run, not where: `htop`, `k9s --context {{context}}`, `claude`. Where is the
project's: everything in a project runs in its directory, on its host as its user (or here, for a
project with no host), as the project says when the session starts, so a project moved elsewhere
takes its sessions there at their next start. On a host, belay's holder there holds it (see Remote
sessions).

Templates are [Mustache](https://mustache.github.io/mustache.5.html) strings. A variable at
the top level is required; anything inside a section only appears when that variable is set:
`k9s{{#context}} --context {{context}}{{/context}}` gives an optional field `context`. The form
for a new session is generated from the fields.
Templates also carry a name template (`k9s {{context}}`; without one the name is the template's,
`@ host` on a host), a default on-exit policy and default values for their fields.

A template can start an **agent** (Claude, Codex or opencode, the Agent field in the editor).
Then the agent's hooks are set up where it runs before the command, and they report back to belay
(on a host through a tunnel belay's connection carries). The built-in Claude, Codex and
opencode templates are just that; a `claude --dangerously-skip-permissions` of your own, marked
Claude, works the same way.

A template that names `{{host}}` in its command writes its own ssh, and runs here as written
(held here, so it survives belay closing, but not its connection dropping).

Built-in variables the server supplies: `shell` (your login shell here), `cwd` (the session
directory), `home`, `name`, `sid` (the belay session id), `port`, `url`, `belaydir`.

A template may also have a **provision** command. It runs first, every start, where the session
runs, and its failure does not stop the main command. Both are run as a terminal runs a shell: by
your login shell there, interactive (`$SHELL -l -i -c "<provision>\n<command>"`), so what your
.bashrc or .zshrc puts on the PATH (`~/.local/bin`, nvm…) is there, as it is when you type `claude`
yourself, and pipes, `&&` and environment assignments work. With no locale set at all (an app
started from the Dock, an sshd that passes none), a session gets a UTF-8 one, as terminals do.

Built-in templates can be edited, deleted, reset one at a time or all together. **Save as
new** in the editor, or **Save as template…** in the new-session dialog, copies a template
with the current field values as its defaults, so Claude with `host=box` becomes a one-click
template.

### Projects and layout

Projects are the tabs in the top bar (Cmd+1 … Cmd+9, or Ctrl outside macOS). **+ Project** asks
for a name, a directory and, for a project on another machine, the host (and a user, where your ssh
config does not set one); click the project in front again to change them, drag a tab to reorder.
Closing a project (its ×, or its menu) only hides it: its sessions carry on and are still its own,
listed under it in the Sessions list as hidden, and opening one of them brings the project back as
it was (the palette lists closed projects too). **Delete project…** in its menu removes it for good. Each holds a dockview layout:
split panes, tab groups, floating groups. Layouts are saved on the server, so another browser or
a reload shows the same arrangement. Every project stays live in the page, so switching is
instant and terminals behind keep receiving output; a session can be in several projects, and
takes the size of the pane you are looking at. Drag a tab onto another project's tab to move it
there, or use **Move to …** in the tab menu.

Sessions not shown in any project keep running.

### The sidebar: sessions and files

The rail down the left opens the sidebar, with a view per button: **Sessions** (Cmd+Shift+S) and
**Files** (Cmd+Shift+E). It opens over the layout and closes once you click elsewhere; 📌 pins it
beside the layout instead, and its right edge drags to resize it. The width and the pin are kept by
the browser.

**Files** is the project's directory as a tree, here or on its host over ssh. `..` at the top goes
up a level (the directory you were in stays open below it), and ⌂ comes back to the project's
directory; the path turns amber while you are elsewhere.
Click a directory to open it in place, a file to open it in an editor tab; the file in front is
marked. Dotfiles show. It follows the project you switch to and remembers, for each, where you
were and which directories were open. Opening a directory or a file keeps the list where it is;
long names scroll sideways. ↻ reads the directories again.

**Sessions** lists the Claude, Codex and opencode sessions; shells are not in it. Its badge counts
the agents waiting for a prompt, amber when one needs you. The session in front is marked (a light
accent, following you from tab to tab), so it is easy to find in the list. Each row has:

- a star, for the ones to look at first (☆ in a session's own bar stars it too);
- its name, and its project;
- where it stands, **idle** (waiting for a prompt), **needs you**, **working**, or **exited** /
  **stopped**;
- how long it has been like that, counting up.

The times are the conversation's, not the process's. belay keeps each conversation's last turn
with the session (when the prompt went in, when the agent finished it), so idle counts from the end
of the last turn and working from the prompt, through any pause to ask you something. They survive
belay restarting, as the agents do: a turn in progress is still working, since the agent never
stopped. An agent started again after its machine restarted, resuming its conversation, shows as
idle since its last turn ended straight away; a turn that restart cut off ends when it was cut
off. A new conversation (`/clear`, say) starts its own count.

A session belongs to the project it was last open in. Close its tab and it is **hidden**: still
listed under that project, grayed, once **Hidden** is switched on. A click opens it in that
project again, and it is no longer hidden.

The switches at the top show or hide **Idle** (idle, needs you, stopped), **Working** and
**Hidden**. **Group** puts the rows under their projects, in the order of the project tabs, or
under Claude, Codex and opencode, or in one list. **Order** is least recent first, most recent
first, or by name, and **★** keeps starred ones at the top. Stars and projects are kept on the
server; the rest, and the sidebar's width, is remembered by the browser.

A click goes to the session where it is open: its tab in this project, else the first project
that has it. It never moves a session between projects. Right-click a row to open it in this
project anyway, split it in beside the current pane, edit, duplicate, restart, stop or delete it.
New sessions start from their project (the + after its tabs), so they know which project they are
in.

A group can do without its tab bar, for a dashboard of pages, notes and terminals you look at
rather than switch between: **Hide tab bar** in a tab's right-click menu (or Show / hide tab bar
in the palette). The layout remembers it. The pane's own bar fades to a thin dark strip with no
name or path, only ▭, which brings the tab bar back (point at the strip to see it clearly); you
need the tab bar back to drag the group somewhere else. Next / previous tab still steps through
a group without its tab bar.

### Clipboard and files

Programs in a pane can set your clipboard with OSC 52, the escape sequence terminals use for
it. Claude Code's `/copy` sends it when it finds no clipboard tool, as in a container or over
ssh. Only the pane you are looking at copies, so other browsers and projects showing the same
session do not. Over HTTPS or `localhost` the copy happens straight away. On plain HTTP the
browser allows a copy only right after a key press or click; when it refuses, a message with a
**Copy** button appears instead.

File paths in a terminal's output are links: absolute, `~/`, `./` and `../` paths, paths with a
slash, and names with an extension, each with an optional `:line`. In a local session they are
resolved from the session's directory and only text files that exist are links, colored and
underlined all the time. In a remote
session any path with a slash is a link, read over ssh (`BatchMode`, so it needs a key, not a
password) relative to the session's `dir`. The file opens in an editor tab, at the line if one
was given; the same file again reuses its tab.

### Open in VS Code

belay shows files so you can talk to agents about them; for real editing there is VS Code. Right-click
a file link in a terminal, a file in the files sidebar, or a file tab for **Open in VS Code**
(Option-click a link or a file in the sidebar does it straight away; an open file has VS Code's mark
on its bar, which opens it at the cursor's line). It is a `vscode://` link the browser hands to VS
Code on your computer: `vscode://vscode-remote/ssh-remote+<host>/<path>:<line>`, always with a line
(`:1` when there is none: without one, VS Code takes the path for a workspace and replaces the window). VS Code names a
Remote-SSH window `ssh-remote+` and the ssh host it connected to, and only a link naming exactly that
opens the file in your window rather than switching the window to another remote.

So the one setting (asked for the first time; Settings → General changes it) is that host, as in your
ssh config: `devbox`, say, not `user@host`. `local` opens files on the computer VS Code runs
on. A file on a project's host opens on that host, by the project's host name.

### Files and the editor

Files open in Monaco, the editor inside VS Code, with its keys and its language for the file's
name. On top of those are the keys from the HUD's notes: Cmd+D duplicates the selection, Cmd+L
adds the next match to the selection, Shift+Delete deletes the line, Cmd+Shift+Up / Down move
lines, Option+Shift+Up / Down add cursors, and Option+Shift+= / - zoom. (Cmd is Ctrl outside
macOS.) belay's own shortcuts come first, so Cmd+Shift+[ / ] still step tabs.

The palette sizes every editor's text at once: Editor: larger text, smaller text, and reset text
size, which goes back to the terminals' size (Settings → General has it as Editor font size). It
is kept in the settings, so every browser gets it. Word wrap is per tab: Editor: toggle word wrap
in the palette, or Word wrap in the tab's right-click menu. Files start unwrapped and notes
wrapped, and the layout remembers each tab's choice.

**File…** in the + menu, or Open file (Cmd+O, Ctrl+Shift+O elsewhere), takes a path on the
project's machine, completed from its directories as you type: here, or over ssh on the
project's host. A path that is not there yet opens empty and is made on the first save.

Cmd+S (or Save in the bar) saves, and so does the focus leaving the editor: another tab, a
terminal, another window. A tab with unsaved changes shows a dot where its close button is, and
closing it from the keyboard asks to save, drop the changes or stay (clicking its × moves the
focus, which saves it first). belay remembers the hash of the file
it loaded. If the file changed on disk since, Cmd+S asks before overwriting it, and a save as the
focus leaves does not overwrite it at all: the tab says "changed on disk: not saved" until you
press Cmd+S and choose; with nothing
edited, coming back to the tab or the window reloads it. Unsaved text is kept in the browser
until it is saved, so a reload or moving the tab to another project brings it back. Files are
saved in place, so they keep their owner and mode. Files up to 2 MB can be edited; a larger one
shows its first 2 MB read-only, and anything with a NUL byte is refused as binary. The editor
loads the first time a note or file opens (a few MB, cached after that), and a file's text is
never rendered as HTML.

### PDFs, images, video and audio

A PDF, image, video or audio file opens in a viewer tab instead of the editor, from the files
sidebar, Open file, or a path printed in a terminal (media files are links there too). The browser
shows it itself: its PDF viewer (zoom, search, print), the image (click for actual size or to fit,
transparency on a checkerboard), or a player that seeks. That works for a project's host too: the
file comes over ssh, a range at a time for video and audio. While its tab is in view the file is
watched (every couple of seconds here, every ten over ssh) and shown again when it changes, so a
PDF or image a build writes stays current beside its terminal; a player keeps its place. ↗ opens
the file in a browser tab.

Types: PDF; PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG; MP4, M4V, WebM, MOV, OGV and MKV; MP3,
M4A, WAV, OGG, Opus and FLAC. What a browser can play varies: MKV and some MOV files play in
Chrome only, if at all. Only these types are served, with `nosniff`, and an SVG gets a CSP that
lets nothing in it run.

### Web tabs and remote pages

A page tab shows one address, set in its settings: click the active tab to change the address,
the title, or where it opens from. There is no address bar or history; ↗ opens the page in a
real browser tab. The page stays loaded while its tab is hidden or another project is in front,
and the frame cannot navigate belay's own window. There are two kinds:

- **Web page…** (◍) loads in your browser, as any page does: `localhost` is the machine the
  browser runs on. Sites that forbid being framed (`X-Frame-Options`, or `frame-ancestors` in
  their CSP) show the browser's refusal instead.
- **Remote page…** (⇆) is opened from the project's machine: its host over ssh, or the machine
  belay runs on. `localhost:8080` is that machine's port 8080, and names resolve there, so in a
  Kubernetes pod `service.namespace.svc.cluster.local:8080` works as typed. A bare port such as
  `3000` means `localhost:3000`, and `https://` addresses work too (their certificates are not
  checked: these are your own services). Move the tab to another project, or give the project
  another host, and it opens from there.

belay serves each remote page under a name of its own, `page-<id>.localhost:7681`; browsers send
any `*.localhost` name to this machine, so it rides the same ssh tunnel or port as belay. With
its own origin the app runs at `/` with its own cookies and storage, and belay's cookie never
reaches it. Requests and WebSockets go through as they are, with the `Host` and `Origin` the app
expects (so dev servers that check them are happy), and belay rewrites what would send the browser
to the app's real address (`Location` headers, cookie domains) or keep it out of a frame
(`X-Frame-Options`, `frame-ancestors`, HSTS). Links an app writes out in full, such as
`http://localhost:8080/…`, are left alone. With `BELAY_TOKEN` set, the tab signs the browser in to
each page with a link that lasts ten minutes; the page's cookie is good for that page only. Browsers
count `page-<id>.localhost` and `localhost` as different sites, so for the page in its tab (a frame
of belay) the cookie is a partitioned one, kept for that page under belay; a plain one covers the page
opened on its own. A
project on another host gets one `ssh -N -D` per host while its pages are in use, stopped after
ten idle minutes. An app that is not answering gives a page that says so and retries.

Remote pages need belay opened by a name (`localhost`, or a DNS name with a wildcard for
`page-*`), not an IP address. Chrome, Edge and Firefox resolve `*.localhost` themselves; Safari
does not.

Keys typed into a page go to the page. A web page keeps belay's shortcuts from working until you
click back into a terminal or the tab bar; a remote page hands them back, since belay adds a small
script to it that passes belay's chords on. Either way, a page that takes the keyboard by itself,
on load say, gives it back to belay: only a click puts it in the page.

### Notes

Each project has one note: markdown in a pane of its own, kept on the server and shown the same
in every browser. It uses the editor with the HUD's notes settings: wrapped lines hang under their
text, no line numbers, nothing suggested as you type. Cmd+Shift+K (Ctrl+Shift+K outside macOS)
shows it down the right-hand side and hides it again; **Notes** in the + menu (or on an empty
project) opens it in that group instead. Closing the tab only hides it: whichever way you open it
again, it is the same note, as you left it. Like any tab it can be dragged, split and resized, but
it stays with its project. It saves as you type; a change made in another browser shows up unless
you have unsaved edits. Deleting it (its bar, or the tab menu) removes the text for good, and the
next Notes starts a fresh one.

Projects could once have several notes. A project without a note of its own takes the first one
open in it, and a note no project has shows in the palette as **Recover note: …**, which adds its
text to the end of the current project's note.

### Post-its

Each project also has a post-it wall: a board of notes you pan (scroll, or drag the board) and
zoom (Ctrl/Cmd+scroll). **Post-its** in the + menu opens it as a tab; Show / hide project post-its
in the palette toggles it. Like the note it belongs to its project, stays with it, and closing the
tab only hides it.

- Double-click the board for a new note there, double-click a note to write in it (Escape, or a
  click elsewhere, to finish). Alt+double-click puts a new note on top of another.
- A note that sits entirely inside a bigger one belongs to it: the bigger one becomes a group,
  with its text as a heading, and moving it moves everything inside. Drag a note into a group to
  file it there, out again to take it out.
- **+ Notes** takes a list, one note per line (paste it in; blank lines are skipped), and lays the
  notes out in a grid: inside the selected note, which grows to hold them, or in the middle of the
  view. They are left selected, to move or color together.
- The order notes are drawn in sorts itself out from where they are: whatever is inside sits in
  front of what holds it, so there are no layers to arrange.
- Click a note to select it; Shift / Cmd+click (or its corner dot) adds to the selection,
  Shift+drag across the board selects every note inside the band, Cmd/Ctrl+A selects all. Drag
  any selected note to move them all. Delete removes the selection, Escape clears it.
- 🎨 steps every selected note through four states: yellow (a note as usual), gray (done), green
  and red. The two swatches beside it choose any note and text color; a note color brings a
  text color that reads on it.
- The preview in the corner shows the whole wall and where you are; click or drag in it to go
  there. ⤧ fits the whole wall in view.

The wall is kept on the server and every browser shows the same one; where you are looking is kept
by the browser.

### Scrollback and persistence

belay keeps a headless xterm buffer per session (default 20,000 lines). Attaching a pane replays
it, so reconnects are exact. The buffer is saved to `~/.belay/scrollback/<id>.ansi` every 30
seconds, on exit and when belay closes, with how far into the session's output it reaches; belay,
started again, asks the holder for exactly what came after. State lives in `~/.belay/state.json`.

What survives what:

| event                                  | processes   | scrollback                 | names, dirs, layout |
|----------------------------------------|-------------|----------------------------|---------------------|
| browser or window closed               | keep running | yes                       | yes                 |
| belay closed or restarted              | keep running | yes, and what it missed   | yes                 |
| network lost (to a host)               | keep running | yes, caught up on return  | yes                 |
| the machine a session runs on restarts | started again | restored above a divider | yes                 |

A holder keeps the last 2 MB of each session's output for belay to catch up on; after a longer
absence the oldest of it is gone, and belay marks the gap.

### Claude Code, Codex and opencode

Every session carries `BELAY_SESSION` and `BELAY_URL` in its environment, and `BELAY_HOME`, where
the holder keeps the agents' setup scripts (it carries them, so a host needs nothing else). Claude
templates run `provision-claude.sh` first, which installs `~/.belay/claude-hook.sh` and registers
it in `~/.claude/settings.json` for `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `Stop` and `Notification`. On a host, belay's connection to the holder carries a
reverse tunnel, so the hooks there reach belay. The setup is idempotent and silent once
installed; Claude's and Codex's need `python3` or `node` where the agent runs to edit the settings
file (both agents need one of them anyway).

Codex takes the same kind of hooks. The Codex templates provision `~/.belay/codex-hook.sh` and
register it in `~/.codex/hooks.json` (`$CODEX_HOME` if set) for `SessionStart`, `SessionEnd`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest` and `Stop`. Codex asks once
per machine to trust new hooks: pick **Trust all and continue**. The templates run
`codex --no-daemon`, because Codex otherwise shares one background server between terminals and
runs hooks there, with the environment of whichever terminal started it, so every Codex tab
would report as that one.

opencode has plugins instead of hooks. The opencode templates provision
`~/.config/opencode/plugin/belay.js` (`$XDG_CONFIG_HOME` if set), which turns opencode's events
into the same reports: `session.status` busy or idle, `permission.asked` and `question.asked`
waiting for you. It ignores subagents' sessions.

What the hooks give you:

- **Resume.** The agent reports the conversation id, stored in the session's `session`
  variable. The templates use it: `claude{{#session}} --resume {{session}}{{/session}}`,
  `codex --no-daemon{{#session}} resume {{session}}{{/session}}`,
  `opencode{{#session}} --session {{session}}{{/session}}`. Pick a different conversation inside
  the pane and the id follows.
- **Activity on the tab.** `UserPromptSubmit` and `PreToolUse` mark the session working
  (blue pulsing dot), `Stop` marks it idle (green), a permission `Notification` or
  `PermissionRequest` marks it waiting for you (amber). The dot's tooltip names the agent. The
  project tab carries the same dot, so you can see what is in flight across projects.

The dot on a tab only ever means one of those, or that the session has ended: red when it
exited with an error, a gray ring when it was stopped or exited cleanly. A running shell has no
dot; its name turns bold when it printed something while you were not looking.

To set all three up by hand on any machine: `node bin/belay.js hook install`, or pipe
`hold/scripts/provision-claude.sh`, `provision-codex.sh` or `provision-opencode.sh` to `sh` over ssh.

## Remote sessions

A session on a host is held there by belay's holder, `belay-hold`: one static binary, with nothing
for it to depend on, no Python, no Node, no libraries. The first time belay starts a session on a
host it checks the system (`uname`) and copies the matching build to `~/.belay/bin/` over ssh.
After that it keeps one ssh connection per host to the holder (`belay-hold connect`), and every
session on the host goes through it. Builds exist for Linux (x86-64, ARM64, 32-bit ARM) and
macOS (Intel and Apple silicon).

belay runs your `ssh`, so your ssh config applies as it does on the command line: Host names,
HostName, Port, IdentityFile, ProxyJump, agents, Include, all of it. A project's host is a name from
it (the Host fields offer them as you type), a host name or an address, with `:port` when it needs
one (`10.0.0.5:2222`, `[fe80::1]:22`); `user@host` typed there splits into host and user. Under the
field belay says where ssh will really connect (`ssh -G`, which connects to nothing).

- **The user.** When your ssh config sets a User for the host (in its Host block, a pattern that
  matches it, or `Host *`), that is the user: the project's User field is off. It is only for hosts
  the config leaves to belay.
- **One login per host.** belay's short connections to a host (files, media, putting the holder
  there) share one ssh login (ControlMaster, sockets in `/tmp/belay-<uid>`), kept ten minutes after
  the last and closed when belay quits: file lists are quick, and a key's passphrase or a second
  factor is asked for once. The holder's connection uses it when it is there.
- **A host met for the first time** is trusted on first use (`StrictHostKeyChecking=accept-new`),
  so its first session is held rather than plain ssh; a host whose key has changed is still
  refused. A StrictHostKeyChecking of your own, for the host, is kept.
- **Your config's own habits** do not get in the way: a `RemoteCommand` or `RequestTTY` for the
  host (one that attaches tmux, say) is set aside for belay's connections, and port forwards
  (`LocalForward`…) are left out of the ones that need none, so a second connection never fails
  on a port the first one holds.

What a host needs: an ssh login with your key or agent (no password prompt), a shell with `mkdir`,
`cat`, `chmod` and `mv` (busybox will do), and a home directory it can write. On the host belay
keeps only `~/.belay`: the holder (`bin/`), the agents' setup scripts (`scripts/`), its socket and
log. Deleting the directory removes everything; the holder exits on its own once it holds nothing.

- **The connection drops.** The session carries on. Its pane says *reconnecting…*; belay tries
  again, sooner and then every 30 seconds, and catches up on everything in between once it is back.
- **belay is closed.** Sessions carry on everywhere. Started again, belay reconnects to each host's
  holder and follows on from where it was.
- **A host belay cannot hold sessions on**: one that asks for a password, one whose key has changed
  (or that your config wants confirmed), or a system there is no build for. belay runs the session over plain `ssh -t`
  from here instead (it can ask for the password in the pane), held here, and the pane says
  *not held*: it ends if the connection drops.
- **A host that cannot be reached** at all is an error, shown in the session; Restart tries again.
- Agent sessions report through a reverse tunnel to belay's port on the host. If that port is taken
  there (another belay), ssh says "remote port forwarding failed" and those hooks cannot report.
- On a Linux host where logind kills a user's processes at logout (`KillUserProcesses=yes`, not
  the default), the holder goes with the last login. `loginctl enable-linger` keeps it.

## Security

belay binds to `127.0.0.1` by default. Reach it over an SSH tunnel
(`ssh -L 7681:127.0.0.1:7681 host`) or a private network such as Tailscale. If you bind to
another address, set `BELAY_TOKEN`; the first visit takes `?token=…` and sets a cookie. The
hook endpoint only accepts posts made on this machine (the remote template's ssh tunnel counts) that
name an existing session id, and keeps the conversation id only when it is a plain token, since it
ends up on a command line.

belay refuses any request or websocket that another page sent (one whose `Origin` is not belay's
own), with or without the cookie. That matters for remote pages: they live on subdomains of
belay's name, which browsers count as the same site, so the cookie's `SameSite` alone would not
keep a page's scripts away from belay's API. A remote page reaches only the address it was opened
for, and only with its own cookie; the key script belay adds to it only reports chords.

Anyone who can open the page has your shell. Do not expose it to the internet.

## Shortcuts

The modifier is Cmd on macOS and Ctrl everywhere else. The command palette lists every
command with its keys, and all of them can be changed in Settings → Shortcuts.

| macOS                     | other                     | action                                   |
|---------------------------|---------------------------|------------------------------------------|
| Cmd+Shift+P               | Ctrl+Shift+P              | command palette                          |
| Cmd+T                     | Ctrl+Shift+`              | new session                              |
| Cmd+Shift+S               | Ctrl+Shift+S              | sessions sidebar                         |
| Cmd+Shift+E               | Ctrl+Shift+E              | files sidebar                            |
| Cmd+Shift+D               | Ctrl+Shift+D              | new project                              |
| Cmd+Shift+K               | Ctrl+Shift+K              | show / hide the project's notes          |
| Cmd+O                     | Ctrl+Shift+O              | open file                                |
| Cmd+S                     | Ctrl+S                    | save the file (in an editor)             |
| Cmd+Shift+] / [, Ctrl+Tab | Ctrl+Tab, Ctrl+Shift+] / [ | next / previous tab in the project      |
| Cmd+1 … 9                 | Ctrl+1 … 9                | switch project                           |
| Cmd+Shift+Enter           | Ctrl+Shift+Enter          | maximize / restore pane (or double-click its bar) |
| Cmd+F                     | Ctrl+Shift+F              | find in pane                             |
| Cmd+Shift+R               | Ctrl+Shift+R              | restart pane                             |
| Cmd+W, Cmd+Shift+X        | Ctrl+Shift+W, Ctrl+Shift+X | close the tab (its session keeps running) |
| Cmd+,                     | Ctrl+,                    | settings                                 |
| Cmd+C / V                 | Ctrl+Shift+C / V          | copy / paste                             |
| right-click               | right-click               | paste, or copy when text is selected     |
| Shift+Enter               | Shift+Enter               | newline in an agent, Enter in a shell    |
| Cmd+Left / Right          |                           | start / end of line                      |

Shift+Enter sends ESC CR (what Option+Enter sends), the newline in Claude Code, Codex and
opencode, in a pane started from an agent template or whose hooks report an agent running. Bash
leaves ESC CR unbound, so in a shell it stays a plain Enter. Cmd+Left / Right send
Ctrl+A / Ctrl+E, as iTerm2's natural text editing does; xterm.js on its own sends nothing for them.

Next / previous tab walks the panes of the current project in group order, or the tabs of a
maximized group. Past the last tab it carries on to the first tab of the next project, and
before the first back to the last tab of the previous one. Cmd+Tab belongs to macOS, so the Mac set uses Chrome's own tab chords.
In a browser tab Chrome keeps those (Cmd+Shift+] / [, Ctrl+Tab), Cmd+T and Cmd+W for itself;
the installed app hands them to belay, so there Cmd+W closes the tab in front, not belay's window. Next / previous project, New shell, New Claude, New Codex, New opencode and Duplicate have no default
keys; the palette has them all. The keyboard always goes with the tab you step to, so stepping onto
a page or a file never leaves you typing in the pane before.

## API

All JSON under `/api`. `GET /api/state` returns everything the page needs.
Sessions: `GET|POST /api/sessions`, `GET|PATCH|DELETE /api/sessions/:id`,
`POST /api/sessions/:id/start|stop|restart`, `GET /api/sessions/:id/scrollback?plain=1`.
Templates: `GET|POST /api/templates`, `PUT|DELETE /api/templates/:id`,
`POST /api/templates/:id/reset`, `POST /api/templates/preview`, `POST /api/templates/reset`.
Notes: `GET|POST /api/notes`, `GET|PUT|DELETE /api/notes/:id`. Post-it walls: `GET|POST /api/walls`,
`GET|PUT|DELETE /api/walls/:id` (`PUT {items, title}`; an item is `{id, text, x, y, w, h, color, fontColor}`). Files:
`POST /api/files/resolve {cwd, paths}`, `GET /api/files?path=&host=&user=&dir=` (with the file's
`hash`), `PUT /api/files {path, host, user, dir, text, base, create, force}` (409 when the file's
hash is no longer `base`), `GET /api/files/raw?path=&host=&user=&dir=` (a media file's bytes,
`Range` honored), `GET /api/files/stat?…` (`{size, mtime}`), `GET /api/fs/entries?path=&host=&user=&dir=`. Remote pages:
`POST /api/pages {address, host, user}` returns the page's origin and sign-in URL. Projects:
`PUT /api/projects {projects, origin}`. Also `GET|PUT /api/settings`,
`GET /api/fs/dirs?path=`, `POST /api/hook/claude|codex|opencode?belay=<sid>`.

The websocket at `/ws` multiplexes every pane: `attach {sid,cols,rows}`, `detach`, `input`,
`resize` up; `replay`, `data`, `exit`, `session`, `session-removed`, `templates`, `projects`,
`note`, `note-removed`, `settings` down.

## Development

```sh
npm run watch     # rebuild the bundle on change
npm run dev       # server
npm test          # end-to-end tests: REST, websocket, exit policies, belay restarting, remote
                  # sessions and pages through a private sshd (when this machine has one), and
                  # the holder's own Go tests
npm run build:hold # the holder for every system (hold/dist/); --here for just this one
xvfb-run -a node test/app.mjs   # the app itself, end to end (BELAY_APP=dist/linux-unpacked/belay
                  # for a packaged one); needs playwright like test:ui
npm run test:ui   # drives the real UI in headless Chromium; needs: npm i -D playwright && npx playwright install chromium
```

Layout: `server/` (plain Node ESM, no TypeScript, no build step; `pages.js` and `tunnels.js` are
remote pages), `web/` (bundled by esbuild into `public/`, with the PWA manifest, service worker
and generated icons; `web/monaco.js` is Monaco's own bundle, built by `scripts/build-monaco.mjs`
into `public/monaco/` and loaded when an editor opens), `shared/template-core.js` (template logic
used by both), `shared/chords.js` (key chords, also served into remote pages), `bin/belay.js` (CLI),
`app/` (the Electron app: `main.js` runs the server in its own process and opens the window),
`site/` (the website, published by `.github/workflows/site.yml`), `hold/` (the holder, Go with no dependencies: `daemon.go` owns the terminals, `proto.go` is the
wire format, `server/hold.js` is belay's side of it; `hold/scripts/provision-*.sh` are the
agents' hook and plugin installers it carries).

## Releasing

Set `version` in `package.json`, commit, and push a tag for it (`git tag v0.2.0 && git push --tags`).
CI tests on Linux and macOS, builds the apps (macOS: `.dmg` and `.zip` for Apple silicon and Intel;
Linux: AppImage and `.deb` for x86-64 and ARM64) and publishes them as that release, under the
names the website links to.
