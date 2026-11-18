package main

import (
	"bytes"
	"embed"
	"os"
	"path/filepath"
)

// The agents' setup scripts travel inside the holder, so a host needs only this one file: wherever the holder
// runs, they are written to ~/.belay/scripts, and a session that starts an agent runs its script first.
//
//go:embed scripts/*.sh
var scripts embed.FS

// installScripts writes the scripts that are missing or different.
func installScripts(dir string) error {
	ents, err := scripts.ReadDir("scripts")
	if err != nil {
		return err
	}
	out := filepath.Join(dir, "scripts")
	if err := os.MkdirAll(out, 0o700); err != nil {
		return err
	}
	for _, e := range ents {
		b, _ := scripts.ReadFile("scripts/" + e.Name())
		p := filepath.Join(out, e.Name())
		if have, err := os.ReadFile(p); err == nil && bytes.Equal(have, b) {
			continue
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, b, 0o700); err != nil {
			return err
		}
		if err := os.Rename(tmp, p); err != nil {
			return err
		}
	}
	return nil
}
