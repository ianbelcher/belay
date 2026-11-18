//go:build linux || darwin

package main

import (
	"os"
	"syscall"
	"unsafe"
)

func ioctl(fd, req, arg uintptr) error {
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg); e != 0 {
		return e
	}
	return nil
}

type winsize struct{ rows, cols, x, y uint16 }

// setSize tells the terminal (and so the program in it, by SIGWINCH) its size.
func setSize(m *os.File, cols, rows int) error {
	ws := winsize{rows: uint16(rows), cols: uint16(cols)}
	rc, err := m.SyscallConn()
	if err != nil {
		return err
	}
	var ierr error
	if err := rc.Control(func(fd uintptr) { ierr = ioctl(fd, syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws))) }); err != nil {
		return err
	}
	return ierr
}
