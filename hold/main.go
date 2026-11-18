// belay-hold keeps terminal sessions running for belay, on this machine or on a host belay reaches over ssh.
// It needs nothing installed: one static binary, kept in ~/.belay/bin.
//
//	belay-hold connect   relay stdin/stdout to the holder, starting it if need be (what belay runs over ssh)
//	belay-hold daemon    run the holder in the foreground
//	belay-hold ensure    start the holder if it is not running, and print its socket
//	belay-hold version
package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// version is set when the binary is built (-ldflags "-X main.version=...").
var version = "dev"

func main() {
	noInherit()
	dir := os.Getenv("BELAY_HOLD_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fatal("no home directory: %v", err)
		}
		dir = filepath.Join(home, ".belay")
	}
	cmd := "connect"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	switch cmd {
	case "version", "--version":
		fmt.Printf("%s %d\n", version, ProtoVersion)
	case "daemon":
		if f, err := os.OpenFile(filepath.Join(dir, "hold.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil && os.Getenv("BELAY_HOLD_LOG_STDERR") == "" {
			log.SetOutput(f)
		}
		if err := runDaemon(dir); err != nil {
			fatal("%v", err)
		}
	case "ensure":
		if err := installScripts(dir); err != nil {
			fatal("could not write the setup scripts: %v", err)
		}
		if _, err := ensure(dir); err != nil {
			fatal("%v", err)
		}
		fmt.Println(sockPath(dir))
	case "connect":
		if err := installScripts(dir); err != nil {
			fatal("could not write the setup scripts: %v", err)
		}
		conn, err := ensure(dir)
		if err != nil {
			fatal("%v", err)
		}
		relay(conn)
	default:
		fatal("usage: belay-hold connect|daemon|ensure|version")
	}
}

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "belay-hold: "+f+"\n", a...)
	os.Exit(1)
}

// ensure connects to the holder, starting it first if it is not running: this binary again, as `daemon`, in
// a session of its own, so it outlives the ssh connection or the app that started it.
func ensure(dir string) (net.Conn, error) {
	sock := sockPath(dir)
	if c, err := net.Dial("unix", sock); err == nil {
		return c, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(self, "daemon")
	cmd.Stdin, cmd.Stdout, cmd.Stderr = null, null, null
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go cmd.Wait() // a second holder exits at once; this reaps it
	for i := 0; i < 100; i++ {
		if c, err := net.Dial("unix", sock); err == nil {
			return c, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("the holder did not start; see %s", filepath.Join(dir, "hold.log"))
}

// relay joins stdin/stdout to the holder until either side ends.
func relay(conn net.Conn) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(conn, os.Stdin); done <- struct{}{} }()
	go func() { io.Copy(os.Stdout, conn); done <- struct{}{} }()
	<-done
	conn.Close()
}
