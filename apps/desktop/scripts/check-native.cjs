// Do the native modules load inside Electron's main process?
// node-pty ships N-API prebuilds (ABI-stable, should just work).
// better-sqlite3 uses V8 APIs directly and historically needs @electron/rebuild.
const { app } = require('electron');

app.whenReady().then(() => {
  const out = { abi: process.versions.modules };
  for (const name of ['node-pty', 'better-sqlite3']) {
    try {
      require(name);
      out[name] = 'OK';
    } catch (err) {
      out[name] = `FAIL: ${String(err.message).split('\n')[0]}`;
    }
  }
  console.log(JSON.stringify(out, null, 2));
  app.quit();
});
