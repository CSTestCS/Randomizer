//go:build windows

package main

import (
	"os/exec"
	"path/filepath"

	webview2 "github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
)

func fatal(msg string) {
	t, _ := windows.UTF16PtrFromString("Randomizer")
	m, _ := windows.UTF16PtrFromString(msg)
	windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONERROR)
}

func main() {
	if err := initDirs(); err != nil {
		fatal("Could not create data folder: " + err.Error())
		return
	}
	url, err := startServer("127.0.0.1:0")
	if err != nil {
		fatal("Could not start: " + err.Error())
		return
	}
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(dataDir, "webview"),
		WindowOptions: webview2.WindowOptions{
			Title:  "Randomizer",
			Width:  1280,
			Height: 820,
			Center: true,
		},
	})
	if w == nil {
		// WebView2 runtime missing: fall back to the default browser.
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
		t, _ := windows.UTF16PtrFromString("Randomizer")
		m, _ := windows.UTF16PtrFromString("The Microsoft Edge WebView2 Runtime was not found, so Randomizer opened in your web browser instead.\n\nKeep this message open while you use it. Press OK to quit Randomizer.")
		windows.MessageBox(0, m, t, windows.MB_OK|windows.MB_ICONINFORMATION)
		return
	}
	defer w.Destroy()
	w.SetSize(960, 640, webview2.HintMin)
	w.Navigate(url)
	w.Run()
}
