// node unrar_cli.mjs archive.rar outDir
// Unpack the .dem files of a RAR archive with the WebAssembly UnRAR the web
// version uses (fallback for cs2demo/archives.py when no unrar / 7-Zip /
// bsdtar is installed). Streams: the archive is read in slices and each demo
// is written as it is unpacked. Prints the written paths, one per line.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { openRar, isDemo, baseName } = await import(pathToFileURL(path.join(here, 'web/js/parse/rar.js')).href);

const [archive, outDir] = process.argv.slice(2);
const fd = fs.openSync(archive, 'r');
const rar = await openRar({
  size: fs.fstatSync(fd).size,
  readAt: (pos, len) => {
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, pos);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  },
  wasmBinary: fs.readFileSync(path.join(here, 'web/vendor/unrar/unrar.wasm')),
});
fs.mkdirSync(outDir, { recursive: true });
for (const entry of rar.list().filter((e) => isDemo(e.name) && !e.encrypted)) {
  const dest = path.join(outDir, baseName(entry.name));
  const out = fs.openSync(dest, 'w');
  rar.extract(entry.name, (chunk) => fs.writeSync(out, chunk));
  fs.closeSync(out);
  console.log(dest);
}
