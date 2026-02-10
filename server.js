const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT_DIR = __dirname;
const DATA_FILE = path.join(ROOT_DIR, 'data.json');
const PORT = 5500;

const ensureDataFile = () => {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { odf: {}, subregions: {} };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  }
};

const readData = () => {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.odf) parsed.odf = {};
    if (!parsed.subregions) parsed.subregions = {};
    return parsed;
  } catch {
    return { odf: {}, subregions: {} };
  }
};

const writeData = (data) => {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
};

const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sendText = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 2_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const keyFor = (region, sub) => `${region}||${sub}`;

const normalizeCustomFields = (port, defs) => {
  const result = {};
  const defList = Array.isArray(defs) ? defs : [];
  const existingMap =
    port && typeof port.customFields === 'object' && !Array.isArray(port.customFields)
      ? port.customFields
      : null;
  const legacyArray = port && Array.isArray(port.extraFieldValues) ? port.extraFieldValues : null;
  const legacyObjects = port && Array.isArray(port.extraFields) ? port.extraFields : null;

  defList.forEach((label, index) => {
    const key = String(label || '').trim();
    if (!key) return;
    let value = '';
    if (existingMap && Object.prototype.hasOwnProperty.call(existingMap, key)) {
      value = existingMap[key];
    } else if (legacyArray && index < legacyArray.length) {
      value = legacyArray[index];
    } else if (legacyObjects && index < legacyObjects.length) {
      value = legacyObjects[index] && legacyObjects[index].value !== undefined ? legacyObjects[index].value : '';
    }
    result[key] = value;
  });

  return result;
};

const normalizeEntry = (entry) => {
  if (!entry || !Array.isArray(entry.ports)) {
    return null;
  }
  const parsedCount = Number(entry.displayCount);
  const desiredCount = Number.isFinite(parsedCount)
    ? Math.max(parsedCount, entry.ports.length)
    : entry.ports.length;
  let ports = entry.ports.slice(0, desiredCount);

  const deriveDefs = (portsList) => {
    const fromEntry = Array.isArray(entry.extraFieldDefs) ? entry.extraFieldDefs : null;
    if (fromEntry && fromEntry.length > 0) return fromEntry;
    const firstWithMap = (portsList || []).find(
      (p) => p && typeof p.customFields === 'object' && !Array.isArray(p.customFields)
    );
    if (firstWithMap) {
      return Object.keys(firstWithMap.customFields);
    }
    return [];
  };

  const extraFieldDefs = deriveDefs(ports);

  ports = ports.map((port, index) => {
    const { extraFieldValues, extraFields, customFields, ...rest } = port || {};
    return {
      ...rest,
      id: index + 1,
      label: `PORT-${String(index + 1).padStart(3, '0')}`,
      customFields: normalizeCustomFields(port, extraFieldDefs)
    };
  });

  return {
    ...entry,
    ports,
    displayCount: ports.length,
    extraFieldDefs
  };
};

const entryNeedsUpdate = (original, normalized) => {
  if (!normalized) return false;
  if (!original) return true;
  if (original.displayCount !== normalized.displayCount) return true;
  if (!Array.isArray(original.ports) || original.ports.length !== normalized.ports.length) return true;
  for (let i = 0; i < normalized.ports.length; i++) {
    const o = original.ports[i];
    const n = normalized.ports[i];
    if (!o || o.id !== n.id || o.label !== n.label) return true;
  }
  return false;
};

const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
};

const serveStatic = (req, res, pathname) => {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(ROOT_DIR, decodeURIComponent(filePath));
  const normalized = path.normalize(fullPath);

  if (!normalized.startsWith(ROOT_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(normalized, (err, stats) => {
    if (err || !stats.isFile()) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const mime = getMimeType(normalized);
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(normalized).pipe(res);
  });
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (pathname.startsWith('/api/')) {
    try {
      if (pathname === '/api/odf' && req.method === 'GET') {
        const region = searchParams.get('region');
        const sub = searchParams.get('sub');
        if (!region || !sub) {
          sendJson(res, 400, { error: 'Missing region or sub' });
          return;
        }
        const data = readData();
        const key = keyFor(region, sub);
        const entry = data.odf[key];
        if (!entry) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        const normalized = normalizeEntry(entry);
        if (!normalized) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        if (entryNeedsUpdate(entry, normalized)) {
          data.odf[key] = normalized;
          writeData(data);
        }
        sendJson(res, 200, normalized);
        return;
      }

      if (pathname === '/api/odf' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = JSON.parse(body || '{}');
        const { region, sub, ports, displayCount, extraFieldDefs } = payload;
        if (!region || !sub || !Array.isArray(ports)) {
          sendJson(res, 400, { error: 'Invalid payload' });
          return;
        }
        const data = readData();
        const lastSave = new Date().toISOString();
        const parsedCount = Number(displayCount);
        const desiredCount = Number.isFinite(parsedCount) ? parsedCount : ports.length;
        const normalized = normalizeEntry({
          region,
          sub,
          ports,
          displayCount: desiredCount,
          lastSave,
          extraFieldDefs
        });
        data.odf[keyFor(region, sub)] = normalized;
        writeData(data);
        sendJson(res, 200, { ok: true, lastSave });
        return;
      }

      if (pathname === '/api/odf' && req.method === 'DELETE') {
        const region = searchParams.get('region');
        const sub = searchParams.get('sub');
        if (!region || !sub) {
          sendJson(res, 400, { error: 'Missing region or sub' });
          return;
        }
        const data = readData();
        delete data.odf[keyFor(region, sub)];
        writeData(data);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === '/api/subregions' && req.method === 'GET') {
        const region = searchParams.get('region');
        if (!region) {
          sendJson(res, 400, { error: 'Missing region' });
          return;
        }
        const data = readData();
        const list = data.subregions[region] || [];
        sendJson(res, 200, { items: list });
        return;
      }

      if (pathname === '/api/subregions' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = JSON.parse(body || '{}');
        const { region, items } = payload;
        if (!region || !Array.isArray(items)) {
          sendJson(res, 400, { error: 'Invalid payload' });
          return;
        }
        const data = readData();
        data.subregions[region] = items;
        writeData(data);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'Unknown API route' });
    } catch (error) {
      sendJson(res, 500, { error: 'Server error', details: error.message });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`ODF app running at http://localhost:${PORT}`);
});
