// Prints the runtime versions the main process actually sees. `modules` is the
// native ABI that better-sqlite3 must be built against.
const { app } = require('electron');

app.whenReady().then(() => {
  console.log(
    JSON.stringify(
      {
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
        modules: process.versions.modules,
      },
      null,
      2,
    ),
  );
  app.quit();
});
