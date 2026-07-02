import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { latLonToMercator } from '../projection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getTag(tags, key) {
  const v = tags?.[key];
  return v != null ? String(v).trim().toLowerCase() : '';
}

function nodeInBbox(lat, lon, bbox) {
  return lon >= bbox.minLon && lon <= bbox.maxLon &&
         lat >= bbox.minLat && lat <= bbox.maxLat;
}

async function createPbfStream(pbfPath) {
  const parseOSM = (await import('osm-pbf-parser')).default;
  const resolved = path.isAbsolute(pbfPath) ? pbfPath : path.resolve(process.cwd(), pbfPath);
  return fs.createReadStream(resolved).pipe(parseOSM());
}

export async function parsePbfBusStops(pbfPath, bbox, onProgress) {
  const through2 = (await import('through2')).default;
  const stops = [];
  const stream = await createPbfStream(pbfPath);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    stream.pipe(through2.obj(function (items, enc, next) {
      for (const item of items) {
        if (item.type !== 'node' || item.lat == null || item.lon == null) continue;
        const tags = item.tags || {};
        const highway = getTag(tags, 'highway');
        const pt      = getTag(tags, 'public_transport');
        const bus     = getTag(tags, 'bus');
        const isBusStop = highway === 'bus_stop' || (pt === 'platform' && bus === 'yes');
        if (!isBusStop) continue;
        if (!nodeInBbox(item.lat, item.lon, bbox)) continue;
        const m = latLonToMercator(item.lat, item.lon);
        stops.push({ id: item.id, lat: item.lat, lon: item.lon, mx: m.x, my: m.y,
                     name: tags.name || null });
      }
      chunks++;
      if (onProgress && chunks % 50 === 0) onProgress(stops.length, chunks, 'bus-stops');
      next();
    })).on('finish', resolve).on('error', reject);
  });
  return stops;
}
