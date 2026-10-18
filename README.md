[README.md](https://github.com/user-attachments/files/33596211/README.md)
# librip

A sticky-note pinboard in the GNOME top panel (GNOME Shell 51). Write notes, pin images and files on a clothesline that scrolls sideways.

## Install

```sh
unzip libreob@local.zip -d ~/.local/share/gnome-shell/extensions/libreob@local
gnome-extensions enable libreob@local
```

Log out and back in the first time (Wayland). The bundled fonts are installed on first enable and picked up after that login.

## Use

- **Note**: new sticky note, saved as you type. Click the dot to change its colour.
- **Image / file**: pick files to pin them.
- **Paste** (Ctrl+V): pins a copied image, files, or text (as a note).
- Scroll the line with the mouse wheel, a touchpad, or the arrow buttons.
- Hover a card for copy, open and remove buttons.

Data is stored in `~/.local/share/libreob/`.

## Fonts

Thickhead and Northampton are bundled in `fonts/` and copied to `~/.local/share/fonts/libreob` on first enable (GNOME Shell cannot load fonts from CSS). Without them the extension falls back to Cantarell.

## Credits

The clothesline idea and the motion model (swing, gusts, springs) come from [Tendedero](https://github.com/alejandrobujan/tendedero) by Alejandro Buján. No code, name or artwork was reused.

## License

public domain so no license
