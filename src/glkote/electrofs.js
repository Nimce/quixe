/* ElectroFS -- a Javascript load/save library for IF interfaces
 * Designed by Andrew Plotkin <erkyrath@eblong.com>
 * <http://eblong.com/zarf/glk/glkote.html>
 * 
 * This Javascript library is copyright 2016 by Andrew Plotkin.
 * It is distributed under the MIT license; see the "LICENSE" file.
 *
 * This is a (mostly-) drop-in replacement for dialog.js for the Electron.io
 * environment. It uses the Node.js "fs" and "path" packages to read and write
 * files, and the Electron.io "dialog" package to present file-selection
 * dialogs.
 *
 * The interface is similar to dialog.js, but not exactly the same. (Sorry!
 * The Atom/Electron API didn't exist when I write dialog.js, or I would
 * have come up with a cleaner abstraction.)
 *
 * This presents itself as a Dialog module. To distinguish it from dialog.js,
 * look at Dialog.streaming, which will be true for electrofs.js and false for
 * dialog.js.
 */

Dialog = function() {

const fs = require('fs');
const path_mod = require('path');
const buffer_mod = require('buffer');
var userpath = require('electron').remote.app.getPath('userData');
var extfilepath = path_mod.join(userpath, 'quixe-files');

/* We try to create a directory for external files at launch time.
   This will usually fail because there's already a directory there.
*/
try {
    fs.mkdirSync(extfilepath);
}
catch (ex) {}

/* Constants -- same as in glkapi.js. */
const filemode_Write = 0x01;
const filemode_Read = 0x02;
const filemode_ReadWrite = 0x03;
const filemode_WriteAppend = 0x05;
const seekmode_Start = 0;
const seekmode_Current = 1;
const seekmode_End = 2;

/* The size of our stream buffering. */
const BUFFER_SIZE = 256;

/* Construct a file-filter list for a given usage type. These lists are
   used by showOpenDialog and showSaveDialog, below. 
*/
function filters_for_usage(val)
{
    switch (val) {
    case 'data': 
        return [ { name: 'Glk Data File', extensions: ['glkdata'] } ];
    case 'save': 
        return [ { name: 'Glk Save File', extensions: ['glksave'] } ];
    case 'transcript': 
        return [ { name: 'Transcript File', extensions: ['txt'] } ];
    case 'command': 
        return [ { name: 'Command File', extensions: ['txt'] } ];
    default:
        return [];
    }
}

/* Dialog.open(tosave, usage, gameid, callback) -- open a file-choosing dialog
 *
 * The "tosave" flag should be true for a save dialog, false for a load
 * dialog.
 *
 * The "usage" and "gameid" arguments are arbitrary strings which describe the
 * file. These filter the list of files displayed; the dialog will only list
 * files that match the arguments. Pass null to either argument (or both) to
 * skip filtering.
 *
 * The "callback" should be a function. This will be called with a fileref
 * argument (see below) when the user selects a file. If the user cancels the
 * selection, the callback will be called with a null argument.
*/
function dialog_open(tosave, usage, gameid, callback)
{
    const dialog = require('electron').remote.dialog;
    /*### title */
    var opts = {
        filters: filters_for_usage(usage)
    };
    var mainwin = require('electron').remote.getCurrentWindow();
    if (!tosave) {
        opts.properties = ['openFile'];
        dialog.showOpenDialog(mainwin, opts, function(ls) {
                if (!ls || !ls.length) {
                    callback(null);
                }
                else {
                    var ref = { filename:ls[0], usage:usage };
                    callback(ref);
                }
            });
    }
    else {
        dialog.showSaveDialog(mainwin, opts, function(path) {
                if (!path) {
                    callback(null);
                }
                else {
                    var ref = { filename:path, usage:usage };
                    callback(ref);
                }
            });
    }
}

/* Dialog.file_construct_ref(filename, usage, gameid) -- create a fileref
 *
 * Create a fileref. This does not create a file; it's just a thing you can use
 * to read an existing file or create a new one. Any unspecified arguments are
 * assumed to be the empty string.
 */
function file_construct_ref(filename, usage, gameid)
{
    if (!filename)
        filename = '';
    if (!usage)
        usage = '';
    if (!gameid)
        gameid = '';
    var path = path_mod.join(extfilepath, filename);
    var ref = { filename:path, usage:usage };
    return ref;
}

/* Dialog.file_ref_exists(ref) -- returns whether the file exists
 */
function file_ref_exists(ref)
{
    try {
        fs.accessSync(ref.filename, fs.F_OK);
        return true;
    }
    catch (ex) {
        return false;
    }
}

/* Dialog.file_remove_ref(ref) -- delete the file, if it exists
 */
function file_remove_ref(ref)
{
    try {
        fs.unlinkSync(ref.filename);
    }
    catch (ex) { }
}

/* FStream -- constructor for a file stream. This is what file_fopen()
 * returns. It is analogous to a FILE* in C code.
 */
function FStream(fmode, filename)
{
    this.fmode = fmode;
    this.filename = filename;
    this.fd = null; /* will be filled in by file_fopen */

    this.mark = 0; /* read-write position in the file */

    /* We buffer input or output (but never both at the same time). */
    this.buffer = new buffer_mod.Buffer(BUFFER_SIZE);
    /* bufuse is filemode_Read or filemode_Write, if the buffer is being used
       for reading or writing. For writing, the buffer starts at mark and
       covers buflen bytes. For reading, the buffer *ends* at mark having
       covered from bufmark to buflen. */
    this.bufuse = 0; 
    this.buflen = 0; /* how much of the buffer is used */
    this.bufmark = 0; /* how much of the buffer has been read out (readmode only) */
}
FStream.prototype = {

    /* Export constructor for Buffer objects. See
       https://nodejs.org/dist/latest-v5.x/docs/api/buffer.html */
    BufferClass : buffer_mod.Buffer,

    /* fstream.fclose() -- close a file
     */
    fclose : function() {
        if (this.fd === null) {
            GlkOte.log('file_fclose: file already closed: ' + this.filename);
            return;
        }
        /* flush any unwritten data */
        this.fflush();
        fs.closeSync(this.fd);
        this.fd = null;
        this.buffer = null;
    },

    /* fstream.file_fread(len) -- read a given number of bytes from a file
       The data is copied into the given buffer, which must be at least
       len bytes long. Returns the number of bytes read, or 0 if end-of-file.
    */
    fread : function(buf, len) {
        /* got will be our mark in the buf argument. When got reaches
           len, we're done. (Unless we hit EOF first.) */
        var got = 0;

        while (true) {
            if (this.bufuse == filemode_Read) {
                if (this.bufmark < this.buflen) {
                    var want = len - got;
                    if (want > this.buflen - this.bufmark)
                        want = this.buflen - this.bufmark;
                    if (want > 0) {
                        this.buffer.copy(buf, got, this.bufmark, this.bufmark+want);
                        this.bufmark += want;
                        got += want;
                    }
                }
                if (got >= len)
                    return got;
                
                /* We need more, but we've consumed the entire buffer. Fall
                   through to the next step where we will fflush and read. */
            }
            
            if (this.bufuse)
                this.fflush();

            /* ### if len-got >= BUFFER_SIZE, we could read directly and ignore
               our buffer. */
            
            this.bufuse = filemode_Read;
            this.bufmark = 0;
            this.buflen = fs.readSync(this.fd, this.buffer, 0, BUFFER_SIZE, this.mark);
            if (this.buflen == 0) {
                /* End of file. Mark the buffer unused, since it's empty. */
                this.bufuse = 0;
                return got;
            }
            this.mark += this.buflen;
        }
    },

    /* fstream.file_fwrite(str) -- write a string to a file
       The string must contain only byte values (character values 0-255).
       Yes, it is inconsistent that fwrite takes strings but fread
       returns buffers.
    */
    fwrite : function(str) {
        var buf = new buffer_mod.Buffer(str, 'binary');
        var count = fs.writeSync(this.fd, buf, 0, buf.length);
        return count;
    },

    ftell : function() {
        if (this.bufuse == filemode_Read) {
            return this.mark - (this.buflen - this.bufmark);
        }
        else if (this.bufuse == filemode_Write) {
            return this.mark + this.buflen;
        }
        else {
            return this.mark;
        }
    },

    fseek : function(pos, seekmode) {
        /* ### we could seek within the current buffer, which would be
           efficient for small moves. */
        this.fflush();

        var val = 0;
        if (seekmode == seekmode_Current) {
            val = this.mark + pos;
        }
        else if (seekmode == seekmode_End) {
            try {
                var stats = fs.fstatSync(fstream.fd);
                val = stats.size + pos;
            }
            catch (ex) {
                val = this.mark + pos;
            }
        }
        else {
            val = pos;
        }
        if (val < 0)
            val = 0;
        this.mark = val;
    },

    fflush : function() {
        if (this.bufuse == filemode_Read) {
            /* Do nothing, just mark the buffer unused. The mark is already
               at the end-of-buffer. */
        }
        else if (this.bufuse == filemode_Write) {
            if (this.buflen) {
                var count = fs.writeSync(this.fd, this.buffer, 0, this.buflen, this.mark);
                this.mark += count;
            }
        }
        this.bufuse = 0;
        this.buflen = 0;
        this.bufmark = 0;
    }

};

/* Dialog.file_fopen(fmode, ref) -- open a file for reading or writing
 *
 * Returns an FStream object.
 */
function file_fopen(fmode, ref)
{
    /* This object is analogous to a FILE* in C code. Yes, we're 
       reimplementing fopen() for Node.js. I'm not proud. Or tired. 
       The good news is, the logic winds up identical to that in
       the C libraries.
    */
    var fstream = new FStream(fmode, ref.filename);

    /* The spec says that Write, ReadWrite, and WriteAppend create the
       file if necessary. However, open(filename, "r+") doesn't create
       a file. So we have to pre-create it in the ReadWrite and
       WriteAppend cases. (We use "a" so as not to truncate.) */

    if (fmode == filemode_ReadWrite || fmode == filemode_WriteAppend) {
        try {
            var tempfd = fs.openSync(fstream.filename, "a");
            fs.closeSync(tempfd);
        }
        catch (ex) {
            GlkOte.log('file_fopen: failed to open ' + fstream.filename + ': ' + ex);
            return null;
        }
    }

    /* Another Unix quirk: in r+ mode, you're not supposed to flip from
       reading to writing or vice versa without doing an fseek. We will
       track the most recent operation (as lastop) -- Write, Read, or
       0 if either is legal next. */

    var modestr = null;
    switch (fmode) {
        case filemode_Write:
            modestr = "w";
            break;
        case filemode_Read:
            modestr = "r";
            break;
        case filemode_ReadWrite:
            modestr = "r+";
            break;
        case filemode_WriteAppend:
            /* Can't use "a" here, because then fseek wouldn't work.
               Instead we use "r+" and then fseek to the end. */
            modestr = "r+";
            break;
    }

    try {
        fstream.fd = fs.openSync(fstream.filename, modestr);
    }
    catch (ex) {
        GlkOte.log('file_fopen: failed to open ' + fstream.filename + ': ' + ex);
        return null;
    }

    if (fmode == filemode_WriteAppend) {
        /* We must jump to the end of the file. */
        try {
            var stats = fs.fstatSync(fstream.fd);
            fstream.mark = stats.size;
        }
        catch (ex) {}
    }

    return fstream;
}

/* Dialog.file_write(dirent, content, israw) -- write data to the file
 *
 * This call is intended for the non-streaming API, so it does not
 * exist in this version of Dialog.
 */
function file_write(dirent, content, israw)
{
    throw new Error('file_write not implemented in electrofs');
}

/* Dialog.file_read(dirent, israw) -- read data from the file
 *
 * This call is intended for the non-streaming API, so it does not
 * exist in this version of Dialog.
 */
function file_read(dirent, israw)
{
    throw new Error('file_read not implemented in electrofs');
}

/* End of Dialog namespace function. Return the object which will
   become the Dialog global. */
return {
    streaming: true,
    open: dialog_open,

    file_construct_ref: file_construct_ref,
    file_ref_exists: file_ref_exists,
    file_remove_ref: file_remove_ref,
    file_fopen: file_fopen,

    /* stubs for not-implemented functions */
    file_write: file_write,
    file_read: file_read
};

}();

/* End of Dialog library. */
