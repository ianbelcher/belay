package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The holder: one per user per machine, owning every session's terminal so the sessions outlive whoever is
// watching them. belay connects (directly here, through `belay-hold connect` over ssh), starts sessions,
// attaches to them from a byte offset, and goes away again; the sessions carry on.

var (
	bufferCap      = 2 << 20                // output kept per session, for a client that comes back
	queueCap       = 32 << 20               // output queued for one slow client before it is dropped (it reattaches)
	idleExit       = 10 * time.Minute       // with no sessions and no clients for this long, the holder exits
	exitedTTL      = 7 * 24 * time.Hour     // an exited session's status and output are kept this long unless forgotten
	drainWait      = 500 * time.Millisecond // after a process exits, how long its last output may still arrive
	housekeepEvery = 15 * time.Second
)

type session struct {
	id      string
	mu      sync.Mutex
	cmd     *exec.Cmd
	pid     int
	master  *os.File
	buf     []byte // the last output, ending at `end`
	end     uint64 // offset just past the last byte of output
	running bool
	code    int
	signal  int
	exited  time.Time
	cols    int
	rows    int
	clients map[*client]bool
	pausers map[*client]bool
	resume  chan struct{}
	done    chan struct{} // closed when the process is gone and its output read
}

func (s *session) start() uint64 { return s.end - uint64(len(s.buf)) }

type client struct {
	conn   net.Conn
	mu     sync.Mutex
	queue  chan []byte
	queued int
	closed bool
}

func (c *client) send(f []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if c.queued+len(f) > queueCap {
		// Too far behind: it is dropped, and reattaches from the offset it has.
		c.closed = true
		close(c.queue)
		c.conn.Close()
		return
	}
	c.queued += len(f)
	c.queue <- f
}

func (c *client) writer() {
	for f := range c.queue {
		_, err := c.conn.Write(f)
		c.mu.Lock()
		c.queued -= len(f)
		c.mu.Unlock()
		if err != nil {
			c.conn.Close()
		}
	}
}

func (c *client) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.queue)
	}
	c.conn.Close()
}

type holder struct {
	dir      string
	mu       sync.Mutex
	sessions map[string]*session
	clients  map[*client]bool
	idleFrom time.Time
	env      []string
	shell    string
}

func sockPath(dir string) string {
	return filepath.Join(dir, fmt.Sprintf("hold-v%d.sock", ProtoVersion))
}

// runDaemon serves until idle. Only one runs per directory: a second one exits at once.
func runDaemon(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(dir, fmt.Sprintf("hold-v%d.lock", ProtoVersion)), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil // another holder has it
	}
	sock := sockPath(dir)
	os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		return err
	}
	os.Chmod(sock, 0o600)
	// BELAY_HOME is where the holder keeps its things, the agents' setup scripts among them.
	// For tests: a holder that lets go sooner.
	if v := os.Getenv("BELAY_HOLD_IDLE_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			idleExit = time.Duration(n) * time.Second
			housekeepEvery = time.Second
		}
	}
	h := &holder{dir: dir, sessions: map[string]*session{}, clients: map[*client]bool{}, idleFrom: time.Now(), env: setEnv(cleanEnv(os.Environ()), "BELAY_HOME", dir), shell: loginShell()}
	signal.Ignore(syscall.SIGHUP, syscall.SIGPIPE)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		log.Printf("stopping on signal")
		os.Remove(sock)
		os.Exit(0)
	}()
	go h.housekeeping(ln, sock)
	log.Printf("holder %s (protocol %d) pid %d on %s", version, ProtoVersion, os.Getpid(), sock)
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go h.serve(conn)
	}
}

// housekeeping forgets long-exited sessions and exits the holder once there has been nothing to hold a while.
func (h *holder) housekeeping(ln net.Listener, sock string) {
	for range time.Tick(housekeepEvery) {
		h.mu.Lock()
		for id, s := range h.sessions {
			s.mu.Lock()
			old := !s.running && !s.exited.IsZero() && time.Since(s.exited) > exitedTTL
			s.mu.Unlock()
			if old {
				delete(h.sessions, id)
			}
		}
		idle := len(h.sessions) == 0 && len(h.clients) == 0
		if !idle {
			h.idleFrom = time.Now()
		}
		quit := idle && time.Since(h.idleFrom) > idleExit
		h.mu.Unlock()
		if quit {
			log.Printf("nothing to hold; exiting")
			os.Remove(sock)
			ln.Close()
			os.Exit(0)
		}
	}
}

// cleanEnv is the holder's environment for its sessions, without what belonged to the ssh login that
// happened to start it and is gone by the time a session runs.
func cleanEnv(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		k := kv[:strings.IndexByte(kv+"=", '=')]
		switch k {
		case "SSH_AUTH_SOCK", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "TERM", "BELAY_SESSION", "BELAY_URL", "BELAY_SESSION_NAME", "BELAY_HOME":
			continue
		}
		out = append(out, kv)
	}
	return out
}

// loginShell is the user's shell: $SHELL, else the passwd entry, else sh.
func loginShell() string {
	if s := os.Getenv("SHELL"); s != "" {
		return s
	}
	if b, err := os.ReadFile("/etc/passwd"); err == nil {
		uid := fmt.Sprint(os.Getuid())
		for _, l := range strings.Split(string(b), "\n") {
			f := strings.Split(l, ":")
			if len(f) >= 7 && f[2] == uid && f[6] != "" {
				return f[6]
			}
		}
	}
	return "/bin/sh"
}

func (h *holder) serve(conn net.Conn) {
	c := &client{conn: conn, queue: make(chan []byte, 65536)}
	go c.writer()
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.clients, c)
		ss := make([]*session, 0, len(h.sessions))
		for _, s := range h.sessions {
			ss = append(ss, s)
		}
		h.mu.Unlock()
		for _, s := range ss {
			h.detach(s, c)
		}
		c.close()
	}()
	// features: what this holder does that an older one of the same protocol does not.
	hello, _ := json.Marshal(map[string]any{"proto": ProtoVersion, "version": version, "pid": os.Getpid(), "features": []string{"interactive"}})
	c.send(frame(fHello, hello))
	r := bufio.NewReaderSize(conn, 64<<10)
	for {
		typ, p, err := readFrame(r)
		if err != nil {
			return
		}
		switch typ {
		case fInput:
			id, data, ok := parseInput(p)
			if !ok {
				continue
			}
			if s := h.get(id); s != nil {
				s.mu.Lock()
				m := s.master
				run := s.running
				s.mu.Unlock()
				if m != nil && run {
					m.Write(data)
				}
			}
		case fReq:
			var req map[string]any
			if json.Unmarshal(p, &req) != nil {
				continue
			}
			res := h.handle(c, req)
			if res != nil {
				res["rid"] = req["rid"]
				b, _ := json.Marshal(res)
				c.send(frame(fRes, b))
			}
		}
	}
}

func (h *holder) get(id string) *session {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessions[id]
}

func str(m map[string]any, k string) string  { s, _ := m[k].(string); return s }
func num(m map[string]any, k string) float64 { n, _ := m[k].(float64); return n }
func fail(msg string, a ...any) map[string]any {
	return map[string]any{"ok": false, "error": fmt.Sprintf(msg, a...)}
}

// handle answers a request. attach answers itself, so that its answer comes before the output it sends.
func (h *holder) handle(c *client, req map[string]any) map[string]any {
	id := str(req, "id")
	switch str(req, "op") {
	case "list":
		h.mu.Lock()
		list := make([]map[string]any, 0, len(h.sessions))
		for _, s := range h.sessions {
			list = append(list, s.info())
		}
		h.mu.Unlock()
		sort.Slice(list, func(i, j int) bool { return list[i]["id"].(string) < list[j]["id"].(string) })
		return map[string]any{"ok": true, "sessions": list}
	case "spawn":
		return h.spawn(req)
	case "attach":
		s := h.get(id)
		if s == nil {
			return fail("no session %s", id)
		}
		from := uint64(num(req, "from"))
		s.mu.Lock()
		res := s.info()
		res["ok"] = true
		res["rid"] = req["rid"]
		b, _ := json.Marshal(res)
		c.send(frame(fRes, b))
		if from < s.start() {
			from = s.start()
		}
		if from < s.end {
			c.send(outputFrame(s.id, from, s.buf[len(s.buf)-int(s.end-from):]))
		}
		if s.running {
			s.clients[c] = true
		} else {
			c.send(s.exitEvent())
		}
		s.mu.Unlock()
		return nil
	case "detach":
		if s := h.get(id); s != nil {
			h.detach(s, c)
		}
		return map[string]any{"ok": true}
	case "input":
		// For a client that cannot send binary frames; the bytes as a string.
		if s := h.get(id); s != nil {
			s.mu.Lock()
			if s.running {
				s.master.Write([]byte(str(req, "data")))
			}
			s.mu.Unlock()
		}
		return map[string]any{"ok": true}
	case "resize":
		s := h.get(id)
		if s == nil {
			return fail("no session %s", id)
		}
		cols, rows := clampInt(int(num(req, "cols")), 2, 1000), clampInt(int(num(req, "rows")), 1, 1000)
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.running {
			s.cols, s.rows = cols, rows
			setSize(s.master, cols, rows)
		}
		return map[string]any{"ok": true}
	case "pause", "resume":
		s := h.get(id)
		if s == nil {
			return fail("no session %s", id)
		}
		s.setPaused(c, str(req, "op") == "pause")
		return map[string]any{"ok": true}
	case "kill":
		s := h.get(id)
		if s == nil {
			return fail("no session %s", id)
		}
		sig := signalNamed(str(req, "signal"))
		s.mu.Lock()
		pid, run := s.pid, s.running
		s.mu.Unlock()
		if run {
			syscall.Kill(-pid, sig)
			syscall.Kill(pid, sig)
		}
		return map[string]any{"ok": true}
	case "forget":
		s := h.get(id)
		if s == nil {
			return map[string]any{"ok": true}
		}
		s.mu.Lock()
		pid, run := s.pid, s.running
		s.mu.Unlock()
		if run {
			syscall.Kill(-pid, syscall.SIGHUP)
			syscall.Kill(pid, syscall.SIGHUP)
			select {
			case <-s.done:
			case <-time.After(3 * time.Second):
				syscall.Kill(-pid, syscall.SIGKILL)
				syscall.Kill(pid, syscall.SIGKILL)
				<-s.done
			}
		}
		h.mu.Lock()
		if h.sessions[id] == s {
			delete(h.sessions, id)
		}
		h.mu.Unlock()
		return map[string]any{"ok": true}
	case "cwd":
		s := h.get(id)
		if s == nil {
			return fail("no session %s", id)
		}
		s.mu.Lock()
		pid, run := s.pid, s.running
		s.mu.Unlock()
		if !run {
			return map[string]any{"ok": true, "cwd": ""}
		}
		return map[string]any{"ok": true, "cwd": processCwd(pid)}
	}
	return fail("unknown op %q", str(req, "op"))
}

func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

func signalNamed(n string) syscall.Signal {
	switch strings.TrimPrefix(strings.ToUpper(n), "SIG") {
	case "KILL":
		return syscall.SIGKILL
	case "TERM":
		return syscall.SIGTERM
	case "INT":
		return syscall.SIGINT
	}
	return syscall.SIGHUP
}

func (s *session) info() map[string]any {
	return map[string]any{"id": s.id, "pid": s.pid, "running": s.running, "code": s.code, "signal": s.signal,
		"start": s.start(), "end": s.end, "cols": s.cols, "rows": s.rows}
}

func (s *session) exitEvent() []byte {
	b, _ := json.Marshal(map[string]any{"ev": "exit", "id": s.id, "code": s.code, "signal": s.signal, "end": s.end})
	return frame(fEvent, b)
}

func (h *holder) detach(s *session, c *client) {
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
	s.setPaused(c, false)
}

// setPaused: a client too far behind can stop the output for a while (the program then waits to write), and
// lets it go again; a client that goes away lets go too.
func (s *session) setPaused(c *client, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	was := len(s.pausers) > 0
	if on {
		s.pausers[c] = true
	} else {
		delete(s.pausers, c)
	}
	if was && len(s.pausers) == 0 {
		close(s.resume)
		s.resume = make(chan struct{})
	}
}

// spawn starts a session: `script` run by the user's interactive login shell (`argv` instead runs that), in `cwd` (else
// home), with the holder's environment plus `env`.
func (h *holder) spawn(req map[string]any) map[string]any {
	id := str(req, "id")
	if id == "" || len(id) > 64 {
		return fail("a session needs an id")
	}
	h.mu.Lock()
	if old := h.sessions[id]; old != nil {
		old.mu.Lock()
		run := old.running
		old.mu.Unlock()
		if run {
			h.mu.Unlock()
			return fail("session %s is running", id)
		}
	}
	h.mu.Unlock()

	var argv []string
	if a, ok := req["argv"].([]any); ok && len(a) > 0 {
		for _, x := range a {
			s, _ := x.(string)
			argv = append(argv, s)
		}
	} else {
		// As a terminal starts one: a login shell, and interactive, so that it reads what a shell you type in
		// reads (.bashrc, .zshrc: where installers put ~/.local/bin, nvm and the like).
		argv = []string{h.shell, "-l", "-i", "-c", str(req, "script")}
	}
	env := append([]string{}, h.env...)
	if e, ok := req["env"].(map[string]any); ok {
		keys := make([]string, 0, len(e))
		for k := range e {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v, _ := e[k].(string)
			env = setEnv(env, k, v)
		}
	}
	if !hasEnv(env, "SHELL") {
		env = append(env, "SHELL="+h.shell)
	}
	// With no locale at all (an app started from the Dock, an sshd that passes none), a shell is in POSIX and
	// cannot read or show anything but ASCII: as terminals do, a UTF-8 one, which the profile may change.
	if !hasEnv(env, "LANG") && !hasEnv(env, "LC_ALL") && !hasEnv(env, "LC_CTYPE") {
		env = append(env, "LANG="+utf8Locale())
	}
	home, _ := os.UserHomeDir()
	cwd := str(req, "cwd")
	if cwd == "~" || strings.HasPrefix(cwd, "~/") {
		cwd = home + cwd[1:]
	}
	if st, err := os.Stat(cwd); cwd == "" || err != nil || !st.IsDir() {
		cwd = home
	}
	cols, rows := clampInt(int(num(req, "cols")), 2, 1000), clampInt(int(num(req, "rows")), 1, 1000)

	m, slaveName, err := openPty()
	if err != nil {
		return fail("no terminal: %v", err)
	}
	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		m.Close()
		return fail("no terminal: %v", err)
	}
	setSize(m, cols, rows)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Dir = cwd
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		slave.Close()
		m.Close()
		return fail("could not start: %v", err)
	}
	slave.Close()
	s := &session{id: id, cmd: cmd, pid: cmd.Process.Pid, master: m, running: true, cols: cols, rows: rows,
		clients: map[*client]bool{}, pausers: map[*client]bool{}, resume: make(chan struct{}), done: make(chan struct{})}
	h.mu.Lock()
	h.sessions[id] = s
	h.mu.Unlock()
	read := make(chan struct{})
	go s.reader(read)
	go s.waiter(read)
	log.Printf("started %s pid %d", id, s.pid)
	return map[string]any{"ok": true, "pid": s.pid}
}

// utf8Locale is a UTF-8 locale every system of its kind has.
func utf8Locale() string {
	if runtime.GOOS == "darwin" {
		return "en_US.UTF-8"
	}
	return "C.UTF-8"
}

func hasEnv(env []string, k string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, k+"=") {
			return true
		}
	}
	return false
}

func setEnv(env []string, k, v string) []string {
	for i, kv := range env {
		if strings.HasPrefix(kv, k+"=") {
			env[i] = k + "=" + v
			return env
		}
	}
	return append(env, k+"="+v)
}

func (s *session) reader(done chan struct{}) {
	defer close(done)
	b := make([]byte, 64<<10)
	for {
		s.mu.Lock()
		var wait chan struct{}
		if len(s.pausers) > 0 {
			wait = s.resume
		}
		s.mu.Unlock()
		if wait != nil {
			select {
			case <-wait:
			case <-s.done:
				return
			}
		}
		n, err := s.master.Read(b)
		if n > 0 {
			s.mu.Lock()
			off := s.end
			s.buf = append(s.buf, b[:n]...)
			s.end += uint64(n)
			if len(s.buf) > 2*bufferCap {
				s.buf = append([]byte(nil), s.buf[len(s.buf)-bufferCap:]...)
			}
			f := outputFrame(s.id, off, b[:n])
			for c := range s.clients {
				c.send(f)
			}
			s.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// waiter reaps the process and, once its last output is read (or a moment has passed), says it exited.
func (s *session) waiter(read chan struct{}) {
	err := s.cmd.Wait()
	select {
	case <-read:
	case <-time.After(drainWait):
	}
	s.mu.Lock()
	s.master.Close()
	s.running = false
	s.exited = time.Now()
	s.code, s.signal = 0, 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				s.signal = int(ws.Signal())
				s.code = 128 + s.signal
			} else {
				s.code = ee.ExitCode()
			}
		} else {
			s.code = -1
		}
	}
	f := s.exitEvent()
	for c := range s.clients {
		c.send(f)
	}
	s.clients = map[*client]bool{}
	log.Printf("exited %s code %d signal %d", s.id, s.code, s.signal)
	s.mu.Unlock()
	close(s.done)
}
