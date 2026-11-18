// Opening a file in VS Code instead: belay shows files to talk to agents about; editing in earnest happens in
// VS Code. A vscode:// link, handed by the browser to VS Code on your computer, opens the file in the window
// connected over Remote-SSH to the host named in it. VS Code names that remote ssh-remote+<the ssh host it
// connected to>, and only when the link names exactly that does it use your open window rather than switch it.

/**
 * The vscode:// link for a file at a line. A file on a project's host goes to that host; one on belay's machine
 * to `host`, the ssh host your VS Code is connected to (devbox, say), or VS Code's own computer for
 * "local". Null when a project host's path is not a full one.
 */
export function vscodeUrl(file, host) {
  let p = String(file.path || '');
  if (file.host && !p.startsWith('/') && file.dir?.startsWith('/')) p = `${file.dir.replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`;
  if (!p.startsWith('/')) return null;
  // Always a line: without one VS Code takes the path for something to open as a workspace and replaces the
  // window; with one it opens the file in the window.
  const at = `:${Number(file.line) > 0 ? Math.floor(Number(file.line)) : 1}`;
  const enc = p.split('/').map(encodeURIComponent).join('/');
  const remote = file.host || host;
  return remote && remote !== 'local' ? `vscode://vscode-remote/ssh-remote+${remote}${enc}${at}` : `vscode://file${enc}${at}`;
}

/** Opens it, asking once for the ssh host your VS Code is connected to. */
export async function openInVsCode(app, file) {
  let host = app.settings().vscodeHost || '';
  if (!file.host && !host) {
    const answer = await app.ui.prompt('Open in VS Code: which ssh host is your VS Code window connected to?', '',
      'The Host from your ssh config that VS Code\'s Remote-SSH connected to (devbox, say), or "local" when VS Code runs on the machine belay runs on. Settings → General changes it.');
    if (!answer?.trim()) return;
    host = answer.trim().replace(/^ssh-remote\+/, '');
    try { await app.client.api('PUT', '/api/settings', { vscodeHost: host }); } catch (e) { app.ui.toast(e.message); return; }
    if (app.settings().vscodeHost !== host) { app.ui.toast(`Not a host name: ${host}`); return; }
  }
  const url = vscodeUrl(file, host);
  if (!url) { app.ui.toast('VS Code needs the full path of a file on another host'); return; }
  (app.openUrl || ((u) => { window.location.href = u; }))(url);
}

/** VS Code's mark, drawn small for a tab's bar. */
export const VSCODE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="#2489ca" d="M17.6 1.3 9 9.2 4.2 5.5 2.3 6.4v11.2l1.9.9L9 14.8l8.6 7.9 4.1-2V3.3z"/><path fill="#fff" fill-opacity=".85" d="M17.6 6.7 11.3 12l6.3 5.3zM4.6 9l2.5 3-2.5 3z"/></svg>';
