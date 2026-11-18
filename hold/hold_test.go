package main

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A client of the holder for the tests: requests, and output collected per session by offset.
type tclient struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
	rid  int
	out  map[string][]byte
	from map[string]uint64
	evs  []map[string]any
}

func dialHolder(t *testing.T, dir string) *tclient {
	t.Helper()
	var conn net.Conn
	var err error
	for i := 0; i < 100; i++ {
		if conn, err = net.Dial("unix", sockPath(dir)); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		t.Fatalf("no holder: %v", err)
	}
	c := &tclient{t: t, conn: conn, r: bufio.NewReader(conn), out: map[string][]byte{}, from: map[string]uint64{}}
	typ, p := c.next()
	if typ != fHello || !strings.Contains(string(p), `"proto":1`) {
		t.Fatalf("hello: %d %s", typ, p)
	}
	return c
}

func (c *tclient) next() (byte, []byte) {
	c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	typ, p, err := readFrame(c.r)
	if err != nil {
		c.t.Fatalf("read: %v", err)
	}
	switch typ {
	case fOutput:
		n := int(p[0])
		id := string(p[1 : 1+n])
		off := binary.BigEndian.Uint64(p[1+n:])
		if _, ok := c.from[id]; !ok {
			c.from[id] = off
		}
		if want := c.from[id] + uint64(len(c.out[id])); off != want {
			c.t.Fatalf("output for %s at %d, expected %d", id, off, want)
		}
		c.out[id] = append(c.out[id], p[1+n+8:]...)
	case fEvent:
		var ev map[string]any
		json.Unmarshal(p, &ev)
		c.evs = append(c.evs, ev)
	}
	return typ, p
}

func (c *tclient) req(op string, args map[string]any) map[string]any {
	c.rid++
	args["op"], args["rid"] = op, c.rid
	b, _ := json.Marshal(args)
	c.conn.Write(frame(fReq, b))
	for {
		typ, p := c.next()
		if typ == fRes {
			var res map[string]any
			json.Unmarshal(p, &res)
			if int(res["rid"].(float64)) == c.rid {
				return res
			}
		}
	}
}

func (c *tclient) input(id, s string) {
	p := append([]byte{byte(len(id))}, id...)
	c.conn.Write(frame(fInput, append(p, s...)))
}

func (c *tclient) waitFor(id, s string) {
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(string(c.out[id]), s) {
		if time.Now().After(deadline) {
			c.t.Fatalf("waiting for %q in %q", s, c.out[id])
		}
		c.next()
	}
}

func TestHolderKeepsSessionsAcrossClients(t *testing.T) {
	dir := shortDir(t)
	go runDaemon(dir)
	a := dialHolder(t, dir)
	res := a.req("spawn", map[string]any{"id": "s1", "script": "echo started; cat", "cols": 80, "rows": 24, "env": map[string]any{"BELAY_SESSION": "s1"}})
	if res["ok"] != true {
		t.Fatalf("spawn: %v", res)
	}
	if res := a.req("attach", map[string]any{"id": "s1", "from": 0}); res["ok"] != true || res["running"] != true {
		t.Fatalf("attach: %v", res)
	}
	a.waitFor("s1", "started")
	a.input("s1", "one\n")
	a.waitFor("s1", "one\r\none\r\n") // the terminal's echo, then cat's
	seen := uint64(len(a.out["s1"]))
	// The client goes away (the network drops); the session carries on without it.
	a.conn.Close()
	b := dialHolder(t, dir)
	b.req("input", map[string]any{"id": "s1", "data": "two\n"})
	time.Sleep(200 * time.Millisecond)
	// Coming back from where it was: exactly what it missed, from that offset.
	if res := b.req("attach", map[string]any{"id": "s1", "from": seen}); res["running"] != true {
		t.Fatalf("reattach: %v", res)
	}
	b.waitFor("s1", "two")
	if b.from["s1"] != seen || strings.Contains(string(b.out["s1"]), "one") || !strings.HasPrefix(string(b.out["s1"]), "two") {
		t.Fatalf("expected only what came after %d, got %q from %d", seen, b.out["s1"], b.from["s1"])
	}
	// The environment, and the size, reach the program.
	b.input("s1", "\x04")
	b.req("spawn", map[string]any{"id": "s2", "script": `case $- in *i*) echo interactive;; esac; echo "lang=${LANG:-none}"; echo "id=$BELAY_SESSION home=$BELAY_HOME"; stty size; exit 3`, "cols": 100, "rows": 40, "env": map[string]any{"BELAY_SESSION": "s2"}})
	b.req("attach", map[string]any{"id": "s2", "from": 0})
	b.waitFor("s2", "interactive") // the shell reads what a terminal's does
	if os.Getenv("LANG") == "" && os.Getenv("LC_ALL") == "" && os.Getenv("LC_CTYPE") == "" {
		b.waitFor("s2", "lang="+utf8Locale()) // a UTF-8 locale when there was none
	}
	b.waitFor("s2", "id=s2 home="+dir)
	b.waitFor("s2", "40 100")
	for !hasExit(b.evs, "s2") {
		b.next()
	}
	if code := exitOf(b.evs, "s2")["code"]; code != float64(3) {
		t.Fatalf("exit code %v", code)
	}
	// An exited session is still there to be read, until it is forgotten.
	list := b.req("list", map[string]any{})["sessions"].([]any)
	if len(list) != 2 {
		t.Fatalf("list: %v", list)
	}
	b.req("forget", map[string]any{"id": "s2"})
	if n := len(b.req("list", map[string]any{})["sessions"].([]any)); n != 1 {
		t.Fatalf("after forget: %d sessions", n)
	}
	if _, err := os.Stat(filepath.Join(dir, "hold-v1.sock")); err != nil {
		t.Fatal(err)
	}
}

func TestScriptsAreWrittenOnceAndKeptCurrent(t *testing.T) {
	dir := shortDir(t)
	if err := installScripts(dir); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "scripts", "provision-claude.sh")
	b, err := os.ReadFile(p)
	if err != nil || !strings.Contains(string(b), "claude") {
		t.Fatalf("provision-claude.sh: %v", err)
	}
	os.WriteFile(p, []byte("changed"), 0o700)
	installScripts(dir)
	if b2, _ := os.ReadFile(p); string(b2) != string(b) {
		t.Fatal("a changed script is put back")
	}
}

func TestOutputBeyondTheBufferStartsWhereItIsKept(t *testing.T) {
	old := bufferCap
	bufferCap = 1000
	defer func() { bufferCap = old }()
	dir := shortDir(t)
	go runDaemon(dir)
	c := dialHolder(t, dir)
	c.req("spawn", map[string]any{"id": "big", "script": "i=0; while [ $i -lt 400 ]; do echo line-$i; i=$((i+1)); done; echo END; sleep 30", "cols": 80, "rows": 24})
	time.Sleep(500 * time.Millisecond)
	res := c.req("attach", map[string]any{"id": "big", "from": 0})
	c.waitFor("big", "END")
	if start := uint64(res["start"].(float64)); start == 0 || c.from["big"] != start {
		t.Fatalf("expected output from the oldest byte kept (%v), got from %d", res["start"], c.from["big"])
	}
	c.req("kill", map[string]any{"id": "big", "signal": "KILL"})
	for !hasExit(c.evs, "big") {
		c.next()
	}
}

func hasExit(evs []map[string]any, id string) bool { return exitOf(evs, id) != nil }
func exitOf(evs []map[string]any, id string) map[string]any {
	for _, e := range evs {
		if e["ev"] == "exit" && e["id"] == id {
			return e
		}
	}
	return nil
}

// shortDir is a temporary directory with a short path: a unix socket's path may be no longer than 104 bytes on
// macOS, and t.TempDir() there is deep under /var/folders.
func shortDir(t *testing.T) string {
	dir, err := os.MkdirTemp("/tmp", "bh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}
