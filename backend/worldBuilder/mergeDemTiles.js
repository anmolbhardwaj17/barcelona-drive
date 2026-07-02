/**
 * Merge two Copernicus 10m DEM tiles (N28E076, N28E077) horizontally.
 * Uses geotiff only (no GDAL). Output: region.dem.tif (Float32, single band).
 *
 * Run: node worldBuilder/mergeDemTiles.js
 * (from backend/; tiles in data/regions/delhi/ or set DEM_DATA_DIR)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fromArrayBuffer, writeArrayBuffer } from 'geotiff';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TILE_LEFT = 'N28E076_10m.tif';
const TILE_RIGHT = 'N28E077_10m.tif';
const OUT_FILE = 'region.dem.tif';

const DATA_DIR = process.env.DEM_DATA_DIR
  ? path.resolve(process.cwd(), process.env.DEM_DATA_DIR)
  : path.resolve(__dirname, '../../data/regions/delhi');
const OUT_PATH = path.join(DATA_DIR, OUT_FILE);

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function loadTile(filePath) {
  const buf = fs.readFileSync(filePath);
  const tiff = await fromArrayBuffer(toArrayBuffer(buf));
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const rawOrigin = image.getOrigin();
  const originX = Number(rawOrigin[0]);
  const originY = Number(rawOrigin[1]);
  const rawRes = image.getResolution();
  const resX = Number(rawRes[0]);
  const resY = Number(rawRes[1]);
  const raster = await image.readRasters({ interleave: true });
  const data = raster[0] ?? raster;
  const values = Array.isArray(data) ? data : (data && data.length != null ? Array.from(data) : []);
  return { image, width, height, originX, originY, resX, resY, values };
}

function validateTiles(t1, t2) {
  const eps = 1e-9;
  if (Math.abs(t1.resX - t2.resX) > eps || Math.abs(t1.resY - t2.resY) > eps) {
    throw new Error(`Resolution mismatch: left (${t1.resX}, ${t1.resY}), right (${t2.resX}, ${t2.resY})`);
  }
  if (t1.height !== t2.height) {
    throw new Error(`Height mismatch: left ${t1.height}, right ${t2.height}`);
  }
  if (Math.abs(t1.originY - t2.originY) > eps) {
    throw new Error(`Vertical alignment mismatch: originY left ${t1.originY}, right ${t2.originY}`);
  }
  // E076 left, E077 right: right tile should start where left ends (horizontally)
  const leftEndX = t1.originX + t1.width * t1.resX;
  if (Math.abs(leftEndX - t2.originX) > eps * (Math.abs(t2.originX) + 1)) {
    console.warn(`Horizontal alignment: left ends at ${leftEndX}, right starts at ${t2.originX}`);
  }
}

function mergeRasters(left, right) {
  const w1 = left.width;
  const w2 = right.width;
  const h = left.height;
  const newWidth = w1 + w2;
  const merged = new Float32Array(newWidth * h);
  const v1 = left.values;
  const v2 = right.values;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w1; x++) {
      merged[y * newWidth + x] = v1[y * w1 + x] ?? 0;
    }
    for (let x = 0; x < w2; x++) {
      merged[y * newWidth + w1 + x] = v2[y * w2 + x] ?? 0;
    }
  }
  return merged;
}

/**
 * Write merged DEM as GeoTIFF. geotiff.js writer supports 8-bit per sample;
 * for Float32 we pass raw bytes (4 per pixel) as 4 "bands" so allocation
 * is correct, then set GeoTIFF tags. Result: 4 bands of 32-bit float, band 0 = elevation.
 */
function writeMergedGeoTIFF(merged, width, height, originX, originY, resX, resY) {
  const n = width * height;
  const bytes = new Uint8Array(n * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) {
    view.setFloat32(i * 4, merged[i], false);
  }
  const flattened = Array.from(bytes);
  const metadata = {
    width,
    height,
    ModelTiepoint: [0, 0, 0, originX, originY, 0],
    ModelPixelScale: [resX, Math.abs(resY), 0],
    GeographicTypeGeoKey: 4326,
    GeogCitationGeoKey: 'WGS 84',
    GTModelTypeGeoKey: 2,
    BitsPerSample: [32, 32, 32, 32],
    SampleFormat: [3, 3, 3, 3],
    StripByteCounts: [width * height * 4],
  };
  return writeArrayBuffer(flattened, metadata);
}

async function main() {
  const leftPath = path.join(DATA_DIR, TILE_LEFT);
  const rightPath = path.join(DATA_DIR, TILE_RIGHT);
  if (!fs.existsSync(leftPath)) {
    throw new Error(`Left tile not found: ${leftPath}`);
  }
  if (!fs.existsSync(rightPath)) {
    throw new Error(`Right tile not found: ${rightPath}`);
  }

  console.log('Loading left tile:', TILE_LEFT);
  const left = await loadTile(leftPath);
  console.log('Loading right tile:', TILE_RIGHT);
  const right = await loadTile(rightPath);

  console.log('Validating alignment...');
  validateTiles(left, right);

  const newWidth = left.width + right.width;
  const newHeight = left.height;
  const originX = left.originX;
  const originY = left.originY;
  const resX = left.resX;
  const resY = left.resY;

  console.log('Merging rasters...');
  const merged = mergeRasters(left, right);

  console.log('Writing GeoTIFF...');
  const arrayBuffer = writeMergedGeoTIFF(merged, newWidth, newHeight, originX, originY, resX, resY);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, Buffer.from(arrayBuffer));

  const minLon = originX;
  const maxLon = originX + newWidth * resX;
  const minLat = originY - newHeight * Math.abs(resY);
  const maxLat = originY;

  console.log('\nMerged DEM written:', OUT_PATH);
  console.log('  New width:', newWidth);
  console.log('  New height:', newHeight);
  console.log('  New origin:', { originX, originY });
  console.log('  Resolution:', { resX, resY });
  console.log('  Bounds: lon', minLon.toFixed(4), '..', maxLon.toFixed(4), ', lat', minLat.toFixed(4), '..', maxLat.toFixed(4));
  if (minLon <= 78 && maxLon >= 76 && minLat <= 29 && maxLat >= 28) {
    console.log('  Covers 76.x–78.x lon, 28.x–29.x lat: yes');
  } else {
    console.log('  Covers 76.x–78.x lon, 28.x–29.x lat: check bounds above');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
