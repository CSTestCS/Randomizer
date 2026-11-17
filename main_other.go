//go:build !windows

package main

import (
	"fmt"
	"log"
	"os"
)

// Non-Windows builds are for development: serve the UI and print the URL.
func main() {
	if err := initDirs(); err != nil {
		log.Fatal(err)
	}
	addr := os.Getenv("RANDOMIZER_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8765"
	}
	url, err := startServer(addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("Randomizer running at", url, "data:", dataDir)
	select {}
}
