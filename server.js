const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const mysql = require('mysql2/promise');

// ========== CONFIGURATION ==========
const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT) || 5500;

// MySQL connection pool – adjust credentials if needed
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'odf_user',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'odf_manager',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ========== HELPER FUNCTIONS ==========
const sendJson = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const sendText = (res, statusCode, body) => {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
  res.end(body);
};


const parseJsonField = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};


const toText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && value.trim().toLowerCase() == 'null') return '';
  return String(value);
};


const toSqlDate = (value) => {
  if (value === null || value === undefined || value === '') return '';

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'null') return '';

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  // Common ISO/datetime strings -> YYYY-MM-DD
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return '';
};

const MAX_BODY_BYTES = 30_000_000;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        const error = new Error('Payload too large');
        error.statusCode = 413;
        reject(error);
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

// ========== DATABASE HELPERS ==========
/**
 * Fetch an ODF entry by region and sub, including its ports.
 * Returns null if not found.
 */
async function getOdfEntry(region, sub) {
  const [odfRows] = await pool.execute(
    'SELECT id, region, sub, displayCount, lastSave, extraFieldDefs FROM odf_entries WHERE region = ? AND sub = ?',
    [region, sub]
  );
  if (odfRows.length === 0) return null;

  const odf = odfRows[0];
  const [portRows] = await pool.execute(
    `SELECT port_number as id, label, status, fiberType, connectorType,
            destination, otdrDistance, otdrDistanceValue, lastMaintained,
            branchingJoint, cxLocation, notes, customFields
     FROM ports
     WHERE odf_id = ?
     ORDER BY port_number`,
    [odf.id]
  );

  // Transform port_number back to id (1‑based) and ensure customFields is an object
  const ports = portRows.map(row => ({
    ...row,
    fiberType: toText(row.fiberType),
    connectorType: toText(row.connectorType),
    destination: toText(row.destination),
    otdrDistance: toText(row.otdrDistance),
    otdrDistanceValue: toText(row.otdrDistanceValue),
    lastMaintained: toText(row.lastMaintained),
    branchingJoint: toText(row.branchingJoint),
    cxLocation: toText(row.cxLocation),
    notes: toText(row.notes),
    customFields: parseJsonField(row.customFields, {})
  }));

  return {
    region: odf.region,
    sub: odf.sub,
    displayCount: odf.displayCount,
    lastSave: odf.lastSave,
    extraFieldDefs: parseJsonField(odf.extraFieldDefs, []),
    ports
  };
}

/**
 * Save or update an ODF entry and its ports.
 * Uses a transaction.
 */
async function saveOdfEntry(region, sub, ports, displayCount, extraFieldDefs) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Upsert odf_entries
    const [existing] = await connection.execute(
      'SELECT id FROM odf_entries WHERE region = ? AND sub = ?',
      [region, sub]
    );

    let odfId;
    const lastSave = new Date();

    if (existing.length > 0) {
      odfId = existing[0].id;
      await connection.execute(
        `UPDATE odf_entries
         SET displayCount = ?, lastSave = ?, extraFieldDefs = ?
         WHERE id = ?`,
        [displayCount, lastSave, JSON.stringify(extraFieldDefs), odfId]
      );
      // Delete all existing ports for this ODF
      await connection.execute('DELETE FROM ports WHERE odf_id = ?', [odfId]);
    } else {
      const [result] = await connection.execute(
        `INSERT INTO odf_entries (region, sub, displayCount, lastSave, extraFieldDefs)
         VALUES (?, ?, ?, ?, ?)`,
        [region, sub, displayCount, lastSave, JSON.stringify(extraFieldDefs)]
      );
      odfId = result.insertId;
    }

    // Insert new ports (batched to avoid max packet issues on large imports)
    if (ports && ports.length > 0) {
      const portValues = ports.map(p => [
        odfId,
        p.id,
        p.label,
        p.status || 'INACTIVE',
        p.fiberType || '',
        p.connectorType || '',
        toText(p.destination),
        toText(p.otdrDistance),
        toText(p.otdrDistanceValue),
        toSqlDate(p.lastMaintained),
        toText(p.branchingJoint),
        toText(p.cxLocation),
        toText(p.notes),
        p.customFields ? JSON.stringify(p.customFields) : null
      ]);

      const batchSize = 100;
      for (let i = 0; i < portValues.length; i += batchSize) {
        const batch = portValues.slice(i, i + batchSize);
        await connection.query(
          `INSERT INTO ports
           (odf_id, port_number, label, status, fiberType, connectorType,
            destination, otdrDistance, otdrDistanceValue, lastMaintained,
            branchingJoint, cxLocation, notes, customFields)
           VALUES ?`,
          [batch]
        );
      }
    }

    await connection.commit();
    return { lastSave: lastSave.toISOString() };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

/**
 * Delete an ODF entry (ports cascade automatically).
 */
async function deleteOdfEntry(region, sub) {
  const [result] = await pool.execute(
    'DELETE FROM odf_entries WHERE region = ? AND sub = ?',
    [region, sub]
  );
  return result.affectedRows > 0;
}


const DEFAULT_DISPLAY_COUNT = 96;

function createDefaultPorts(count = DEFAULT_DISPLAY_COUNT) {
  const today = new Date().toISOString().split('T')[0];
  const ports = [];
  for (let i = 1; i <= count; i++) {
    ports.push({
      id: i,
      label: `PORT-${String(i).padStart(3, '0')}`,
      status: 'INACTIVE',
      fiberType: 'Single-mode OS2',
      connectorType: 'LC/UPC',
      destination: '',
      otdrDistance: '',
      otdrDistanceValue: '',
      lastMaintained: today,
      branchingJoint: '',
      cxLocation: '',
      notes: '',
      customFields: {}
    });
  }
  return ports;
}

async function ensureOdfEntryExists(connection, region, sub) {
  const [existing] = await connection.execute(
    'SELECT id FROM odf_entries WHERE region = ? AND sub = ?',
    [region, sub]
  );

  if (existing.length > 0) {
    return false;
  }

  const lastSave = new Date();
  const [result] = await connection.execute(
    `INSERT INTO odf_entries (region, sub, displayCount, lastSave, extraFieldDefs)
     VALUES (?, ?, ?, ?, ?)`,
    [region, sub, DEFAULT_DISPLAY_COUNT, lastSave, JSON.stringify([])]
  );
  const odfId = result.insertId;
  const ports = createDefaultPorts(DEFAULT_DISPLAY_COUNT);
  const portValues = ports.map((p) => [
    odfId,
    p.id,
    p.label,
    p.status,
    p.fiberType,
    p.connectorType,
    p.destination,
    p.otdrDistance,
    p.otdrDistanceValue,
    p.lastMaintained,
    p.branchingJoint,
    p.cxLocation,
    p.notes,
    JSON.stringify(p.customFields)
  ]);

  await connection.query(
    `INSERT INTO ports
     (odf_id, port_number, label, status, fiberType, connectorType,
      destination, otdrDistance, otdrDistanceValue, lastMaintained,
      branchingJoint, cxLocation, notes, customFields)
     VALUES ?`,
    [portValues]
  );

  return true;
}

/**
 * Search across odf_entries and ports.
 */
async function searchData(keyword) {
  const trimmedKeyword = String(keyword || '').trim();
  const keywordLower = `%${trimmedKeyword.toLowerCase()}%`;
  const limit = 100;
  const resultMap = new Map();

  const buildBaseLink = (region, sub) =>
    `/odf.html?region=${encodeURIComponent(region)}&sub=${encodeURIComponent(sub)}`;

  const pushUnique = (item) => {
    const key = `${item.region}||${item.sub}||${item.portNumber || 0}`;
    if (!resultMap.has(key)) {
      resultMap.set(key, item);
    }
  };

  // Search in odf_entries metadata
  const [odfResults] = await pool.query(
    `SELECT id, region, sub, extraFieldDefs
     FROM odf_entries
     WHERE LOWER(region) LIKE ?
        OR LOWER(sub) LIKE ?
        OR LOWER(COALESCE(CAST(extraFieldDefs AS CHAR), '')) LIKE ?
     LIMIT 100`,
    [keywordLower, keywordLower, keywordLower]
  );

  for (const odf of odfResults) {
    const link = buildBaseLink(odf.region, odf.sub);
    pushUnique({
      region: odf.region,
      sub: odf.sub,
      storageKey: `${odf.region}||${odf.sub}`,
      jsonPath: `odf["${odf.region}||${odf.sub}"]`,
      matchedValue: `${odf.region} ${odf.sub}`,
      link,
      exactLink: link,
      portNumber: null,
      fieldPath: '',
      keyword: trimmedKeyword
    });
    if (resultMap.size >= limit) break;
  }

  // Search in ports across all important fields (including status/custom fields)
  const [portResults] = await pool.query(
    `SELECT p.port_number, p.label, p.status, p.destination, p.otdrDistance,
            p.otdrDistanceValue, p.branchingJoint, p.cxLocation, p.notes,
            p.fiberType, p.connectorType, p.customFields, o.region, o.sub
     FROM ports p
     JOIN odf_entries o ON p.odf_id = o.id
     WHERE LOWER(COALESCE(p.label, '')) LIKE ?
        OR LOWER(COALESCE(p.status, '')) LIKE ?
        OR LOWER(COALESCE(p.destination, '')) LIKE ?
        OR LOWER(COALESCE(p.notes, '')) LIKE ?
        OR LOWER(COALESCE(p.fiberType, '')) LIKE ?
        OR LOWER(COALESCE(p.connectorType, '')) LIKE ?
        OR LOWER(COALESCE(p.otdrDistance, '')) LIKE ?
        OR LOWER(COALESCE(p.otdrDistanceValue, '')) LIKE ?
        OR LOWER(COALESCE(p.branchingJoint, '')) LIKE ?
        OR LOWER(COALESCE(p.cxLocation, '')) LIKE ?
        OR LOWER(COALESCE(CAST(p.customFields AS CHAR), '')) LIKE ?
     LIMIT 100`,
    [
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower,
      keywordLower
    ]
  );

  for (const row of portResults) {
    const baseLink = buildBaseLink(row.region, row.sub);
    const exactLink = `${baseLink}&port=${encodeURIComponent(row.port_number)}`;
    pushUnique({
      region: row.region,
      sub: row.sub,
      storageKey: `${row.region}||${row.sub}`,
      jsonPath: `odf["${row.region}||${row.sub}"].ports[${row.port_number - 1}]`,
      matchedValue: `Port ${row.port_number}: ${row.label || ''} | ${row.status || ''} | ${row.destination || ''}`.trim(),
      link: exactLink,
      exactLink,
      portNumber: row.port_number,
      fieldPath: '',
      keyword: trimmedKeyword
    });
    if (resultMap.size >= limit) break;
  }

  const items = Array.from(resultMap.values()).slice(0, limit);
  return {
    keyword: trimmedKeyword,
    total: items.length,
    items
  };
}

// ========== STATIC FILE SERVING ==========
const getMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml'
  };
  return mimes[ext] || 'application/octet-stream';
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

// ========== HTTP SERVER ==========
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (pathname.startsWith('/api/')) {
    try {
      // ===== GET /api/odf =====
      if (pathname === '/api/odf' && req.method === 'GET') {
        const region = searchParams.get('region');
        const sub = searchParams.get('sub');
        if (!region || !sub) {
          sendJson(res, 400, { error: 'Missing region or sub' });
          return;
        }
        const entry = await getOdfEntry(region, sub);
        if (!entry) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        sendJson(res, 200, entry);
        return;
      }

      // ===== POST /api/odf =====
      if (pathname === '/api/odf' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = JSON.parse(body || '{}');
        const { region, sub, ports, displayCount, extraFieldDefs } = payload;
        if (!region || !sub || !Array.isArray(ports)) {
          sendJson(res, 400, { error: 'Invalid payload' });
          return;
        }
        const result = await saveOdfEntry(region, sub, ports, displayCount, extraFieldDefs || []);
        sendJson(res, 200, { ok: true, lastSave: result.lastSave });
        return;
      }

      // ===== DELETE /api/odf =====
      if (pathname === '/api/odf' && req.method === 'DELETE') {
        const region = searchParams.get('region');
        const sub = searchParams.get('sub');
        if (!region || !sub) {
          sendJson(res, 400, { error: 'Missing region or sub' });
          return;
        }
        const deleted = await deleteOdfEntry(region, sub);
        sendJson(res, deleted ? 200 : 404, { ok: deleted });
        return;
      }

      // ===== GET /api/search =====
      if (pathname === '/api/search' && req.method === 'GET') {
        const keyword = (searchParams.get('keyword') || '').trim();
        if (!keyword) {
          sendJson(res, 400, { error: 'Missing keyword' });
          return;
        }
        const response = await searchData(keyword);
        sendJson(res, 200, response);
        return;
      }

      // ===== GET /api/subregions =====
      if (pathname === '/api/subregions' && req.method === 'GET') {
        const region = searchParams.get('region');
        if (!region) {
          sendJson(res, 400, { error: 'Missing region' });
          return;
        }
        const [rows] = await pool.execute(
          'SELECT sub FROM subregions WHERE region = ? ORDER BY sub',
          [region]
        );
        const items = rows.map(r => r.sub);
        sendJson(res, 200, { items });
        return;
      }

      // ===== POST /api/subregions =====
      if (pathname === '/api/subregions' && req.method === 'POST') {
        const body = await readBody(req);
        const payload = JSON.parse(body || '{}');
        const { region, items } = payload;
        if (!region || !Array.isArray(items)) {
          sendJson(res, 400, { error: 'Invalid payload' });
          return;
        }

        const normalizedItems = [...new Set(
          items
            .map(sub => String(sub || '').trim())
            .filter(Boolean)
        )];

        const connection = await pool.getConnection();
        try {
          await connection.beginTransaction();

          const [currentRows] = await connection.execute(
            'SELECT sub FROM subregions WHERE region = ?',
            [region]
          );
          const currentItems = currentRows.map(r => r.sub);

          const nextSet = new Set(normalizedItems);
          const currentSet = new Set(currentItems);
          const removedSubs = currentItems.filter(sub => !nextSet.has(sub));
          const addedSubs = normalizedItems.filter(sub => !currentSet.has(sub));

          await connection.execute('DELETE FROM subregions WHERE region = ?', [region]);
          if (normalizedItems.length > 0) {
            const values = normalizedItems.map(sub => [region, sub]);
            await connection.query('INSERT INTO subregions (region, sub) VALUES ?', [values]);
          }

          if (removedSubs.length > 0) {
            const placeholders = removedSubs.map(() => '?').join(', ');
            await connection.execute(
              `DELETE FROM odf_entries WHERE region = ? AND sub IN (${placeholders})`,
              [region, ...removedSubs]
            );
          }

          let createdCount = 0;
          for (const sub of addedSubs) {
            const created = await ensureOdfEntryExists(connection, region, sub);
            if (created) createdCount += 1;
          }

          await connection.commit();
          sendJson(res, 200, {
            ok: true,
            added: addedSubs.length,
            removed: removedSubs.length,
            created: createdCount
          });
        } catch (err) {
          await connection.rollback();
          throw err;
        } finally {
          connection.release();
        }
        return;
      }

      sendJson(res, 404, { error: 'Unknown API route' });
    } catch (error) {
      console.error('API Error:', error);
      const statusCode = error && error.statusCode ? error.statusCode : 500;
      sendJson(res, statusCode, { error: 'Server error', details: error.message });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`ODF app running at http://localhost:${PORT}`);
});
