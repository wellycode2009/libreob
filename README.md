# libreob

A sticky-note pinboard in the GNOME top panel (GNOME Shell 51).
The clothesline layout comes from [Tendedero](https://github.com/alejandrobujan/tendedero).

- **Note**: new sticky note. Type directly on it; it saves as you type.
- **Image / file**: opens a file picker; the chosen files are copied onto the board.
- **Paste** (or Ctrl+V): pastes a copied image (e.g. a screenshot), copied files, or text (becomes a note).
- Card buttons: coloured dot cycles the colour, copy, open (images/files), close removes it.

Data: `~/.local/share/libreob/` (`board.json` plus `files/`).

## Install
    cp -r libreob@local ~/.local/share/gnome-shell/extensions/
    gnome-extensions enable libreob@local
Log out and back in the first time (Wayland can't reload the shell).

Test without logging out: `dbus-run-session -- gnome-shell --devkit`
