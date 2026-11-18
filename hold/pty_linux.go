package main

import (
	"os"
	"strconv"
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
			var unlock int32
			if ierr = ioctl(fd, syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); ierr != nil {
				return
			}
			var n uint32
			if ierr = ioctl(fd, syscall.TIOCGPTN, uintptr(unsafe.Pointer(&n))); ierr != nil {
				return
			}
			name = "/dev/pts/" + strconv.Itoa(int(n))
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

// processCwd is the working directory of a process, for following a shell's cd.
func processCwd(pid int) string {
	p, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
	if err != nil {
		return ""
	}
	return p
}
