/**
 * Generate the application icon.
 *
 * The mark is defined here as drawing code rather than checked in as a binary
 * blob we can no longer edit, so changing the brand is a code change with a
 * diff. It is drawn by Electron's own Chromium — the same engine that draws the
 * app, and the only renderer we already depend on.
 *
 *   npm run icon -w @shipyard/desktop
 *
 * Output: build/icon.ico (Windows, seven sizes) and build/icon.png (1024px, the
 * source electron-builder resamples for macOS and Linux).
 *
 * Committed to the repo. CI packages the app; it does not re-render artwork,
 * because a build should not be able to silently change what the icon looks
 * like.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, nativeImage } from 'electron';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(HERE, '..', 'build');

/**
 * Windows picks the nearest contained size rather than scaling a single one, so
 * the sizes its shell actually asks for all have to be present: 16 in the title
 * bar, 32 in the taskbar, 48 in Explorer's medium view, 256 in the large one.
 */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The source size electron-builder resamples for macOS and Linux. */
const PNG_SIZE = 1024;

/**
 * The mark: the wordmark's initial on the product's primary green, drawn
 * full-bleed with the corner radius Windows 11 expects an app to supply itself.
 *
 * Two variants, not one scaled. Below about 32px a 22% radius eats the corners
 * of the glyph and a 600 weight thins to nothing, so small sizes get a tighter
 * radius and more weight. The letter is set in the same system font stack the
 * interface uses, so icon and app are visibly the same family.
 */
function drawingScript(canvas, variant) {
  const small = variant === 'small';
  const radius = canvas * (small ? 0.14 : 0.22);
  const weight = small ? 700 : 600;
  const glyph = canvas * (small ? 0.64 : 0.60);

  return `(async () => {
  const c = document.createElement('canvas');
  c.width = ${canvas};
  c.height = ${canvas};
  const ctx = c.getContext('2d');

  // Along the diagonal, light at the top-left, so the mark reads as lit from
  // the same direction as everything else on a Windows desktop.
  const fill = ctx.createLinearGradient(0, 0, ${canvas}, ${canvas});
  fill.addColorStop(0, 'oklch(0.53 0.115 150)');
  fill.addColorStop(1, 'oklch(0.41 0.113 146)');

  ctx.beginPath();
  ctx.roundRect(0, 0, ${canvas}, ${canvas}, ${radius});
  ctx.fillStyle = fill;
  ctx.fill();

  const font = '${weight} ${glyph}px "Segoe UI", system-ui, sans-serif';
  await document.fonts.load(font);
  ctx.font = font;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  // Optical rather than metric centring: 'middle' sits the S visibly low
  // because the baseline box includes descender room the glyph never uses.
  ctx.textBaseline = 'middle';
  ctx.fillText('S', ${canvas / 2}, ${canvas / 2} + ${canvas * 0.015});

  return c.toDataURL('image/png');
})()`;
}

/**
 * Draw one variant on a large canvas and return the image.
 *
 * Drawn into a 2D canvas and read back as a data URL rather than screenshotted:
 * capturePage needs a live compositor, which a hidden window on Windows does
 * not reliably have, and a build script must not depend on a visible window.
 *
 * Drawn big and resampled down rather than drawn at 16px directly, because
 * Chromium's downscale of a 512px render beats its own hinting at icon sizes.
 */
async function render(canvas, variant) {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8">');
  const dataUrl = await win.webContents.executeJavaScript(drawingScript(canvas, variant));
  win.destroy();

  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) throw new Error(`drawing produced no pixels for the ${variant} variant`);
  return image;
}

/**
 * Pack PNGs into an ICO.
 *
 * Windows has accepted PNG-compressed entries since Vista, so each size goes in
 * as the PNG we just rendered — no BMP re-encoding, no alpha mask to get wrong.
 * Layout: a 6-byte header, then one 16-byte directory entry per image, then the
 * images themselves.
 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, index) => {
    const at = index * 16;
    // 256 is stored as 0; the field is a single byte.
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0);
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size: none
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

/** The size below which the small-icon variant is used. */
const SMALL_UP_TO = 32;

app.whenReady().then(async () => {
  try {
    await mkdir(BUILD, { recursive: true });

    const small = await render(512, 'small');
    const large = await render(PNG_SIZE, 'large');

    const images = ICO_SIZES.map((size) => {
      const source = size <= SMALL_UP_TO ? small : large;
      return { size, png: source.resize({ width: size, height: size, quality: 'best' }).toPNG() };
    });
    await writeFile(path.join(BUILD, 'icon.ico'), packIco(images));
    await writeFile(path.join(BUILD, 'icon.png'), large.toPNG());

    process.stdout.write(
      `icon.ico  ${ICO_SIZES.join(', ')} px\n` + `icon.png  ${PNG_SIZE} px\n`,
    );
    app.exit(0);
  } catch (error) {
    process.stderr.write(`icon generation failed: ${String(error)}\n`);
    app.exit(1);
  }
});

// Each size is rendered in its own window and destroyed. Without this the app
// would quit the moment the first one closes, part way through the set.
app.on('window-all-closed', () => {});
