package main

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
)

// The wire format between belay and a holder, the same on a socket here and over ssh: frames of a 4-byte
// big-endian length (of what follows), a type byte, and the payload. Control messages are JSON; output and
// input carry raw bytes after a short binary header, so a terminal's bytes are never re-encoded.
const ProtoVersion = 1

const (
	fHello  byte = 1 // JSON {proto, version, pid}, each way on connect
	fReq    byte = 2 // JSON {rid, op, ...}, belay to holder
	fRes    byte = 3 // JSON {rid, ok, error, ...}, holder to belay
	fOutput byte = 4 // [u8 id length][id][u64 offset][bytes], holder to belay
	fInput  byte = 5 // [u8 id length][id][bytes], belay to holder
	fEvent  byte = 6 // JSON {ev, id, ...}, holder to belay
)

const maxFrame = 16 << 20

var errFrameTooBig = errors.New("frame too big")

func frame(typ byte, payload []byte) []byte {
	b := make([]byte, 5+len(payload))
	binary.BigEndian.PutUint32(b, uint32(1+len(payload)))
	b[4] = typ
	copy(b[5:], payload)
	return b
}

func readFrame(r *bufio.Reader) (byte, []byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 || n > maxFrame {
		return 0, nil, errFrameTooBig
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return 0, nil, err
	}
	return b[0], b[1:], nil
}

func outputFrame(id string, offset uint64, data []byte) []byte {
	p := make([]byte, 1+len(id)+8+len(data))
	p[0] = byte(len(id))
	copy(p[1:], id)
	binary.BigEndian.PutUint64(p[1+len(id):], offset)
	copy(p[1+len(id)+8:], data)
	return frame(fOutput, p)
}

// parseInput splits an input frame's payload into the session id and the bytes typed.
func parseInput(p []byte) (string, []byte, bool) {
	if len(p) < 1 || len(p) < 1+int(p[0]) {
		return "", nil, false
	}
	n := int(p[0])
	return string(p[1 : 1+n]), p[1+n:], true
}
