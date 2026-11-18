package main

import (
	"bytes"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// openPty opens a new pseudo-terminal: the master, and the path of its slave.
func openPty() (*os.File, string, error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, "", err
	}
	var name string
	var ierr error
	rc, err := m.SyscallConn()
	if err == nil {
		err = rc.Control(func(fd uintptr) {
			if ierr = ioctl(fd, syscall.TIOCPTYGRANT, 0); ierr != nil {
				return
			}
			if ierr = ioctl(fd, syscall.TIOCPTYUNLK, 0); ierr != nil {
				return
			}
			buf := make([]byte, 128)
			if ierr = ioctl(fd, syscall.TIOCPTYGNAME, uintptr(unsafe.Pointer(&buf[0]))); ierr != nil {
				return
			}
			name = string(buf[:bytes.IndexByte(buf, 0)])
		})
	}
	if err == nil {
		err = ierr
	}
	if err != nil {
		m.Close()
		return nil, "", err
	}
	return m, name, nil
}

// processCwd is the working directory of a process, for following a shell's cd. macOS has no /proc; lsof
// is part of the system.
func processCwd(pid int) string {
	out, err := exec.Command("/usr/sbin/lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(l, "n/") {
			return l[1:]
		}
	}
	return ""
}
