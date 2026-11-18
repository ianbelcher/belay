//go:build linux || darwin

package main

import (
	"os"
	"runtime"
	"strconv"
	"syscall"
)

// noInherit marks every file this process was handed, beyond stdin, stdout and stderr, as not to be passed
// on. The app that starts the holder has files of its own open (its resources, the pipes it was started
// with); without this the holder, which outlives the app, would keep them open for as long as it runs.
func noInherit() {
	dir := "/dev/fd"
	if runtime.GOOS == "linux" {
		dir = "/proc/self/fd"
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if fd, err := strconv.Atoi(e.Name()); err == nil && fd > 2 {
			syscall.CloseOnExec(fd)
		}
	}
}
