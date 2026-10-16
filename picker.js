// Helper run in a separate process (gjs -m picker.js) because the Shell
// itself cannot open GTK dialogs. Prints one file:// URI per line.
import Gtk from 'gi://Gtk?version=4.0';
import GLib from 'gi://GLib';

GLib.set_prgname('libreob');
Gtk.init();

const loop = new GLib.MainLoop(null, false);
const dialog = new Gtk.FileDialog({title: 'Pin images and files to libreob'});

dialog.open_multiple(null, null, (d, res) => {
    try {
        const list = d.open_multiple_finish(res);
        for (let i = 0; i < list.get_n_items(); i++)
            print(list.get_item(i).get_uri());
    } catch (_e) {
        // dismissed
    }
    loop.quit();
});

loop.run();
