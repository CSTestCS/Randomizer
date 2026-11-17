# Randomizer

A small Windows app for building collections and pulling random entries from them with gacha-style reveal animations.

**Download:** [`dist/Randomizer.exe`](dist/Randomizer.exe) — a single portable file, no installer. Double-click to run.

Requires Windows 10/11 with the Microsoft Edge WebView2 Runtime, which is already installed on nearly all Windows 10/11 machines. If it's missing, the app opens in your default browser instead.

## Using it

- **Collections → Categories → Entries.** Create a collection, add named categories to it, and add entries to each category. An entry needs a name and a rarity, and can have an image.
- **Rarity** sets how likely an entry is to be drawn. Default weights: Common 60, Uncommon 25, Rare 10, Legendary 4, Exotic 1. An entry's chance is its weight divided by the total weight of the entries in its category; each entry card shows its current chance. You can change the weights under ⚙ Settings.
- **Pulling**
  - **Pull entire collection** draws *Per category* results from every category, reveals them one at a time, then shows a results page.
  - **Pull** on a category draws however many *Results* you set for that category.
  - During a reveal: click / Space / Enter to reveal or go to the next result, **C** to claim, Esc to skip to the results page.
- **No repeats** stops an entry from being drawn more than once in the current session. Turning it on or off resets the list of drawn entries, and so does reopening the collection.
- **Claim** any result (during the reveal or on the results page) to keep it in the ★ Claimed panel while you keep pulling.
- **Save session / Load session** stores the no-repeats setting, the list of drawn entries and your claimed results under a name, so you can pick up where you left off.

Data lives in `%APPDATA%\Randomizer` (`library.json`, `images\`, `sessions\`).

## Building

Requires Go 1.24+. Cross-compiles from any OS:

```bash
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -H windowsgui" -o dist/Randomizer.exe .
```

On Linux/macOS, `go run .` starts the same UI at http://127.0.0.1:8765 for development.
