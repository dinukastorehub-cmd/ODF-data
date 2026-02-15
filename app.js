// ========== CONTEXT ==========
const ODFContext = (() => {
    const params = new URLSearchParams(window.location.search);
    const region = params.get('region') || 'Default Region';
    const sub = params.get('sub') || 'Default Sub ODF';
    const requestedPort = Number.parseInt(params.get('port') || '', 10);
    const initialPortId = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : null;

    return { region, sub, initialPortId };
})();

// ========== DATABASE SERVICE ==========
class DatabaseService {
    static async saveStateWithResult(ports, displayCount, extraFieldDefs = []) {
        try {
            const res = await fetch('/api/odf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    region: ODFContext.region,
                    sub: ODFContext.sub,
                    ports,
                    displayCount,
                    extraFieldDefs
                })
            });

            let data = null;
            try {
                data = await res.json();
            } catch {
                data = null;
            }

            if (!res.ok) {
                const errorMessage = (data && (data.details || data.error)) ? (data.details || data.error) : `HTTP ${res.status}`;
                return { ok: false, error: errorMessage };
            }

            this.updateLastSaveTime(data && data.lastSave);
            return { ok: true, error: null };
        } catch (error) {
            return { ok: false, error: error && error.message ? error.message : 'Network error' };
        }
    }

    static async saveState(ports, displayCount, extraFieldDefs = []) {
        const result = await this.saveStateWithResult(ports, displayCount, extraFieldDefs);
        return result.ok;
    }

    static async loadState() {
        try {
            const res = await fetch(`/api/odf?region=${encodeURIComponent(ODFContext.region)}&sub=${encodeURIComponent(ODFContext.sub)}`);
            if (!res.ok) return null;
            const data = await res.json();
            return data;
        } catch {
            return null;
        }
    }

    static updateLastSaveTime(time) {
        if (!time) return;
        const timeElement = document.getElementById('lastSaveTime');
        if (timeElement) {
            const date = new Date(time);
            timeElement.textContent = `Last save: ${date.toLocaleString()}`;
        }
    }

    static exportData() {
        this.exportExcel();
    }

    static exportExcel() {
        if (!window.XLSX) {
            alert('Excel export is not available (XLSX not loaded).');
            return;
        }

        const extraFieldDefs = Array.isArray(AppState.extraFieldDefs) ? AppState.extraFieldDefs : [];
        const headers = [
            'ID',
            'Label',
            'Port Status',
            'Customer',
            'CCT Number',
            'CEA/OLT port',
            'Customer Location',
            'Customer GPS',
            'Live Branching joint',
            'OTDR Distance',
            'Last Modified',
            'Notes',
            ...extraFieldDefs
        ];
        const rows = AppState.ports.map((port) => ({
            'ID': port.id,
            'Label': port.label,
            'Port Status': port.status,
            'Customer': port.destination,
            'CCT Number': port.otdrDistance,
            'CEA/OLT port': port.fiberType,
            'Customer Location': port.connectorType,
            'Customer GPS': port.branchingJoint,
            'Live Branching joint': port.cxLocation,
            'OTDR Distance': port.otdrDistanceValue || '',
            'Last Modified': port.lastMaintained,
            'Notes': port.notes,
            ...extraFieldDefs.reduce((acc, label, index) => {
                const map = port && typeof port.customFields === 'object' && !Array.isArray(port.customFields)
                    ? port.customFields
                    : {};
                acc[label] = Object.prototype.hasOwnProperty.call(map, label) ? map[label] : '';
                return acc;
            }, {})
        }));

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
        XLSX.utils.book_append_sheet(wb, ws, 'Ports');

        const metaRows = [
            ['Region', ODFContext.region],
            ['Sub ODF', ODFContext.sub],
            ['Display Count', AppState.displayCount],
            ['Export Date', new Date().toISOString()]
        ];
        const metaWs = XLSX.utils.aoa_to_sheet(metaRows);
        XLSX.utils.book_append_sheet(wb, metaWs, 'Meta');

        const fileName = `odf_${ODFContext.region}_${ODFContext.sub}_${new Date().toISOString().split('T')[0]}.xlsx`
            .replace(/\s+/g, '_');
        XLSX.writeFile(wb, fileName);

        alert('Excel exported successfully!');
    }


    static importData(file) {
        const name = (file && file.name ? file.name : '').toLowerCase();
        const ext = name.includes('.') ? name.split('.').pop() : '';

        if (!window.XLSX) {
            return Promise.reject(new Error('XLSX not loaded'));
        }

        if (ext !== 'xlsx' && ext !== 'xls') {
            return Promise.reject(new Error('Only Excel files (.xlsx, .xls) are supported'));
        }

        return this.importExcel(file);
    }


    static importExcel(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const data = this.parseExcel(e.target.result);
                    resolve(data);
                } catch (error) {
                    reject(error);
                }
            };
            reader.readAsArrayBuffer(file);
        });
    }

    static parseExcel(buffer) {
        const wb = XLSX.read(buffer, { type: 'array' });
        const sheetName = wb.SheetNames.includes('Ports') ? 'Ports' : wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const headerRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        const headerList = Array.isArray(headerRows) && headerRows.length > 0 ? headerRows[0] : [];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        const extraFieldDefs = [];

        const ports = rows.map((row, index) => this.rowToPort(row, index + 1, extraFieldDefs));
        return {
            ports,
            displayCount: ports.length,
            extraFieldDefs
        };
    }

    static rowToPort(row, index, extraFieldDefs = []) {
        const normalizeKey = (key) => String(key || '')
            .trim()
            .toLowerCase()
            .replace(/[\s_\-]+/g, '');

        const lookup = {};
        Object.entries(row || {}).forEach(([key, value]) => {
            lookup[normalizeKey(key)] = value;
        });

        const pick = (keys) => {
            for (const key of keys) {
                const normalized = normalizeKey(key);
                if (Object.prototype.hasOwnProperty.call(lookup, normalized)) {
                    return lookup[normalized];
                }
            }
            return '';
        };

        const port = AppState.createDefaultPort(index);

        const statusRaw = String(pick(['status', 'port status', 'portstatus']) || '').trim().toUpperCase();
        const allowed = new Set(['ACTIVE', 'INACTIVE', 'FAULTY']);
        if (allowed.has(statusRaw)) {
            port.status = statusRaw;
        }

        const toText = (value) => (value === null || value === undefined) ? '' : String(value);
        const importedOtdr = toText(pick(['otdr distance', 'otdrdistance', 'otdr', 'actual otdr distance', 'actualotdrdistance']));
        port.destination = toText(pick(['customer', 'service', 'destination', 'dest']));
        port.otdrDistance = toText(pick(['cct number', 'cctnumber'])) || importedOtdr;
        port.fiberType = toText(pick(['cea/olt port', 'ceaoltport', 'dab', 'fiber type', 'fibertype', 'fiber']));
        port.connectorType = toText(pick(['customer location', 'customerlocation', 'port', 'connector type', 'connectortype', 'connector']));
        port.branchingJoint = toText(pick(['customer gps', 'customergps', 'branching joint', 'branchingjoint', 'branch joint']));
        port.cxLocation = toText(pick(['live branching joint', 'livebranchingjoint', 'cx location', 'cxlocation']));
        port.otdrDistanceValue = importedOtdr;
        port.notes = toText(pick(['notes', 'note', 'remarks', 'comment']));

        const customFields = {};
        (Array.isArray(extraFieldDefs) ? extraFieldDefs : []).forEach((label) => {
            const normalized = normalizeKey(label);
            customFields[label] = Object.prototype.hasOwnProperty.call(lookup, normalized) ? toText(lookup[normalized]) : '';
        });
        port.customFields = AppState.normalizeCustomFields({ customFields }, extraFieldDefs);

        const lastMaintained = pick(['last modified', 'lastmodified', 'last maintained', 'lastmaintained', 'date', 'lastmaintenancedate']);
        port.lastMaintained = this.normalizeDate(lastMaintained, port.lastMaintained);

        return port;
    }

    static extractExtraFieldDefs(headers) {
        const normalizeKey = (key) => String(key || '')
            .trim()
            .toLowerCase()
            .replace(/[\s_\-]+/g, '');

        const standard = new Set([
            'id',
            'label',
            'status',
            'portstatus',
            'customer',
            'service',
            'destination',
            'dest',
            'cctnumber',
            'otdrdistance',
            'otdr',
            'actualotdrdistance',
            'ceaoltport',
            'dab',
            'fibertype',
            'fiber',
            'customerlocation',
            'port',
            'connectortype',
            'connector',
            'customergps',
            'branchingjoint',
            'branchjoint',
            'livebranchingjoint',
            'cxlocation',
            'lastmodified',
            'lastmaintained',
            'lastmaintenancedate',
            'date',
            'notes',
            'note',
            'remarks',
            'comment'
        ]);

        const unique = new Set();
        const extras = [];
        (Array.isArray(headers) ? headers : []).forEach((header) => {
            const raw = String(header || '').trim();
            if (!raw) return;
            const normalized = normalizeKey(raw);
            if (standard.has(normalized)) return;
            if (unique.has(normalized)) return;
            unique.add(normalized);
            extras.push(raw);
        });
        return extras;
    }

    static normalizeDate(value, fallback) {
        if (!value) return fallback;
        if (value instanceof Date && !Number.isNaN(value.getTime())) {
            return value.toISOString().split('T')[0];
        }
        if (typeof value === 'number' && window.XLSX && XLSX.SSF) {
            const parsed = XLSX.SSF.parse_date_code(value);
            if (parsed && parsed.y && parsed.m && parsed.d) {
                const pad = (n) => String(n).padStart(2, '0');
                return `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}`;
            }
        }
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return fallback;
            const date = new Date(trimmed);
            if (!Number.isNaN(date.getTime())) {
                return date.toISOString().split('T')[0];
            }
            return trimmed;
        }
        return fallback;
    }

    static async resetData() {
        try {
            const res = await fetch(`/api/odf?region=${encodeURIComponent(ODFContext.region)}&sub=${encodeURIComponent(ODFContext.sub)}`, {
                method: 'DELETE'
            });
            return res.ok;
        } catch {
            return false;
        }
    }
}

// ========== APP STATE ==========
const AppState = {
    ports: [],
    displayCount: 96,
    selectedPortId: null,
    maxPorts: 576,
    isEditing: false, // New: track edit mode
    extraFieldDefs: [],

    resolveInitialPortId() {
        const fallback = 1;
        const portCount = Array.isArray(this.ports) ? this.ports.length : 0;
        if (portCount < 1) return fallback;
        const requested = Number(ODFContext.initialPortId);
        if (!Number.isFinite(requested) || requested < 1) return fallback;
        return Math.min(Math.max(1, Math.trunc(requested)), portCount);
    },

    async init() {
        // Load saved data or create mock data
        const saved = await DatabaseService.loadState();
        
        if (saved && Array.isArray(saved.ports) && saved.ports.length > 0) {
            const defsFromSave = Array.isArray(saved.extraFieldDefs) ? saved.extraFieldDefs : null;
            const defs = defsFromSave ? defsFromSave : [];
            this.extraFieldDefs = defs;
            const normalized = this.normalizeLoadedPorts(saved.ports, saved.displayCount, defs);
            this.ports = normalized.ports;
            this.displayCount = normalized.displayCount;
            DatabaseService.updateLastSaveTime(saved.lastSave);
            if (!defsFromSave && defs.length > 0) {
                await DatabaseService.saveState(this.ports, this.displayCount, this.extraFieldDefs);
            }
        } else {
            this.displayCount = 96;
            this.extraFieldDefs = [];
            this.ports = this.generateDefaultPorts(this.displayCount);
            await DatabaseService.saveState(this.ports, this.displayCount, this.extraFieldDefs);
        }
        
        this.selectedPortId = this.resolveInitialPortId();
        this.isEditing = false; // Start in view mode
    },

    generateDefaultPorts(count) {
        const ports = [];
        for (let i = 1; i <= count; i++) {
            ports.push(this.createDefaultPort(i));
        }
        return ports;
    },

    getVisiblePorts() {
        return this.ports;
    },

    getSelectedPort() {
        return this.ports.find(p => p.id === this.selectedPortId) || null;
    },

    addPort() {
        if (this.displayCount < this.maxPorts) {
            const nextId = this.ports.length + 1;
            this.ports.push(this.createDefaultPort(nextId));
            this.displayCount = this.ports.length;
            // Autosave to persist the updated port count and ports list
            DatabaseService.saveState(this.ports, this.displayCount, this.extraFieldDefs);
            return true;
        }
        return false;
    },

    removePort() {
        if (this.displayCount > 1) {
            this.ports.pop();
            this.displayCount = this.ports.length;
            if (this.selectedPortId > this.ports.length) {
                this.selectedPortId = this.ports.length;
            }
            // Autosave to persist the updated port count and ports list
            DatabaseService.saveState(this.ports, this.displayCount, this.extraFieldDefs);
            return true;
        }
        return false;
    },

    updatePort(updatedPort, options = {}) {
        const { keepEditing = false } = options;
        const index = this.ports.findIndex(p => p.id === updatedPort.id);
        if (index !== -1) {
            this.ports[index] = updatedPort;
            DatabaseService.saveState(this.ports, this.displayCount, this.extraFieldDefs);
            if (!keepEditing) {
                this.isEditing = false; // Exit edit mode after save
            }
            return true;
        }
        return false;
    },

    swapPortData(targetPortId) {
        const currentId = this.selectedPortId;
        if (!currentId || !Number.isFinite(targetPortId)) return false;
        if (currentId === targetPortId) return false;

        const currentIndex = this.ports.findIndex(p => p.id === currentId);
        const targetIndex = this.ports.findIndex(p => p.id === targetPortId);
        if (currentIndex === -1 || targetIndex === -1) return false;

        const currentPort = this.ports[currentIndex];
        const targetPort = this.ports[targetIndex];
        const { id: currentPortId, label: currentLabel, ...currentData } = currentPort;
        const { id: targetId, label: targetLabel, ...targetData } = targetPort;

        this.ports[currentIndex] = { id: currentPortId, label: currentLabel, ...targetData };
        this.ports[targetIndex] = { id: targetId, label: targetLabel, ...currentData };
        return true;
    },

    // New: Toggle edit mode
    toggleEditMode() {
        this.isEditing = !this.isEditing;
        return this.isEditing;
    },

    // New: Cancel edit mode
    cancelEdit() {
        this.isEditing = false;
    },

    createDefaultPort(id) {
        const status = 'INACTIVE';
        return {
            id,
            label: `PORT-${id.toString().padStart(3, '0')}`,
            status: status,
            fiberType: 'Single-mode OS2',
            connectorType: 'LC/UPC',
            destination: '',
            otdrDistance: '',
            otdrDistanceValue: '',
            lastMaintained: new Date().toISOString().split('T')[0],
            branchingJoint: '',
            cxLocation: '',
            notes: '',
            customFields: this.normalizeCustomFields({}, this.extraFieldDefs)
        };
    },

    normalizeLoadedPorts(ports, displayCount, extraFieldDefs = []) {
        const parsedCount = Number(displayCount);
        let normalizedPorts = Array.isArray(ports) ? ports.slice() : [];
        if (!Number.isFinite(parsedCount)) {
            normalizedPorts = normalizedPorts;
        } else {
            normalizedPorts = normalizedPorts.slice(0, parsedCount);
        }
        normalizedPorts = normalizedPorts.map((port, index) => {
            const { extraFieldValues, extraFields, customFields: existingCustomFields, ...rest } = port || {};
            const customFields = this.normalizeCustomFields(port, extraFieldDefs);
            const cleanText = (value) => {
                if (value === null || value === undefined) return '';
                if (typeof value === 'string' && value.trim().toLowerCase() === 'null') return '';
                return String(value);
            };

            const cleanDate = (value) => {
                const text = cleanText(value);
                if (!text) return '';
                const match = text.match(/^\d{4}-\d{2}-\d{2}/);
                if (match) return match[0];
                const parsed = new Date(text);
                if (!Number.isNaN(parsed.getTime())) {
                    return parsed.toISOString().split('T')[0];
                }
                return text;
            };

            const basePort = {
                ...rest,
                id: index + 1,
                label: `PORT-${(index + 1).toString().padStart(3, '0')}`,
                fiberType: cleanText(rest && rest.fiberType),
                connectorType: cleanText(rest && rest.connectorType),
                destination: cleanText(rest && rest.destination),
                otdrDistance: cleanText(rest && rest.otdrDistance),
                otdrDistanceValue: cleanText(rest && rest.otdrDistanceValue),
                lastMaintained: cleanDate(rest && rest.lastMaintained),
                branchingJoint: cleanText(rest && rest.branchingJoint),
                cxLocation: cleanText(rest && rest.cxLocation),
                notes: cleanText(rest && rest.notes),
                customFields
            };

            return basePort;
        });
        return {
            ports: normalizedPorts,
            displayCount: normalizedPorts.length
        };
    },
    normalizeCustomFields(port, defs) {
        const result = {};
        const defList = Array.isArray(defs) ? defs : [];
        const legacyArray = port && Array.isArray(port.extraFieldValues) ? port.extraFieldValues : null;
        const legacyObjects = port && Array.isArray(port.extraFields) ? port.extraFields : null;
        const existingMap = port && typeof port.customFields === 'object' && !Array.isArray(port.customFields)
            ? port.customFields
            : null;

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
    },
    deriveExtraFieldDefs(ports) {
        return [];
    }
};

// ========== UI RENDER FUNCTIONS ==========
class UIRenderer {
    static autoSaveTimer = null;

    static renderPortGrid() {
        const grid = document.getElementById('portGrid');
        const visiblePorts = AppState.getVisiblePorts();
        
        grid.innerHTML = '';
        
        visiblePorts.forEach(port => {
            const portElement = document.createElement('div');
            portElement.className = `port-item ${port.status.toLowerCase()} ${AppState.selectedPortId === port.id ? 'selected' : ''}`;
            portElement.textContent = port.id;
            portElement.title = `${port.label} - ${port.status}`;
            
            portElement.addEventListener('click', () => {
                AppState.selectedPortId = port.id;
                AppState.cancelEdit(); // Cancel edit mode when selecting new port
                this.renderPortGrid();
                this.renderPortDetails();
            });
            
            grid.appendChild(portElement);
        });
        
        // Update port count
        document.getElementById('portCount').textContent = `${AppState.displayCount} Ports`;
    }

    static renderPortDetails() {
        const container = document.getElementById('portDetails');
        const port = AppState.getSelectedPort();
        
        if (!port) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">&#128225;</div>
                    <h3>No Port Selected</h3>
                    <p>Click on a port from the grid to view and edit its details</p>
                </div>
            `;
            this.updateFieldControlsVisibility(false, false);
            return;
        }

        const statusColor = {
            'ACTIVE': '#2ecc71',
            'INACTIVE': '#95a5a6',
            'FAULTY': '#e74c3c'
        };

        // Determine if we should show inputs or text
        const isEditing = AppState.isEditing;
        const extraFieldDefs = Array.isArray(AppState.extraFieldDefs) ? AppState.extraFieldDefs : [];
        const customFields = AppState.normalizeCustomFields(port, extraFieldDefs);
        const extraFieldsHtml = extraFieldDefs.map((label, index) => `
            <div class="detail-row extra-field-row" data-index="${index}">
                <div class="detail-label">
                    ${isEditing ?
                        `<input type="text" class="extra-field-label" data-index="${index}" value="${label || ''}" placeholder="Field name">` :
                        `<span class="readonly-text">${label || ''}</span>`
                    }
                </div>
                <div class="detail-value">
                    ${isEditing ?
                        `<input type="text" class="extra-field-value" data-index="${index}" value="${customFields[label] || ''}" placeholder="Value">` :
                        `<span class="readonly-text">${customFields[label] || ''}</span>`
                    }
                </div>
            </div>
        `).join('');
        
        container.innerHTML = `
            <div class="port-details">
                <div class="port-header">
                    <div class="port-title">
                        <h2>${port.label}</h2>
                        <p>Port ID: ${port.id}</p>
                    </div>
                    <div class="port-status" style="background: ${statusColor[port.status]}; color: white;">
                        ${port.status}
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Port Status</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<select id="statusInput">
                                <option value="ACTIVE" ${port.status === 'ACTIVE' ? 'selected' : ''}>ACTIVE</option>
                                <option value="INACTIVE" ${port.status === 'INACTIVE' ? 'selected' : ''}>INACTIVE</option>
                                <option value="FAULTY" ${port.status === 'FAULTY' ? 'selected' : ''}>FAULTY</option>
                            </select>` :
                            `<span class="readonly-text">${port.status}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Customer</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="destinationInput" value="${port.destination}">` :
                            `<span class="readonly-text">${port.destination}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">CCT Number</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="otdrDistanceInput" value="${port.otdrDistance}">` :
                            `<span class="readonly-text">${port.otdrDistance}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">CEA/OLT port</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="fiberTypeInput" value="${port.fiberType}">` :
                            `<span class="readonly-text">${port.fiberType}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Customer Location</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="connectorInput" value="${port.connectorType}">` :
                            `<span class="readonly-text">${port.connectorType}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Customer GPS</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="branchingJointInput" value="${port.branchingJoint}">` :
                            `<span class="readonly-text">${port.branchingJoint}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Live Branching joint</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="cxLocationInput" value="${port.cxLocation}">` :
                            `<span class="readonly-text">${port.cxLocation}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">OTDR Distance</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="text" id="otdrDistanceValueInput" value="${port.otdrDistanceValue || ''}">` :
                            `<span class="readonly-text">${port.otdrDistanceValue || ''}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Last Modified</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<input type="date" id="dateInput" value="${String(port.lastMaintained || '').split('T')[0]}">` :
                            `<span class="readonly-text">${String(port.lastMaintained || '').split('T')[0]}</span>`
                        }
                    </div>
                </div>

                <div class="detail-row">
                    <div class="detail-label">Notes</div>
                    <div class="detail-value">
                        ${isEditing ? 
                            `<textarea id="notesInput">${(port.notes ?? '')}</textarea>` :
                            `<div class="readonly-notes">${(port.notes ?? '')}</div>`
                        }
                    </div>
                </div>

                ${extraFieldsHtml}

                <div class="detail-actions">
                    ${isEditing ? 
                        // Show Save/Cancel when editing
                        `
                        <button id="cancelBtn" class="btn btn-secondary">Cancel</button>
                        <button id="saveChangesBtn" class="btn btn-primary">Save Changes</button>
                        ` :
                        // Show Edit button when viewing
                        `
                        <div class="switch-actions">
                            <button id="switchDataBtn" class="btn btn-secondary">Switch Data</button>
                            <button id="editBtn" class="btn btn-primary">Edit Port</button>
                        </div>
                        <div id="switchBox" class="switch-box" aria-hidden="true">
                            <label for="switchPortInput">Switch with port number</label>
                            <input type="number" id="switchPortInput" min="1" max="${AppState.displayCount}" placeholder="Enter port number">
                            <div class="switch-box-actions">
                                <button id="switchSaveBtn" class="btn btn-primary">Save</button>
                                <button id="switchCancelBtn" class="btn btn-secondary">Cancel</button>
                            </div>
                        </div>
                        `
                    }
                </div>
            </div>
        `;
        this.updateFieldControlsVisibility(isEditing, true);

        // Add event listeners based on mode
        if (isEditing) {
            // Save Changes button
            document.getElementById('saveChangesBtn').addEventListener('click', () => {
                this.savePortChanges(port.id);
            });

            // Auto-save on input changes
            this.initAutoSaveListeners(port.id);

            // Cancel button
            document.getElementById('cancelBtn').addEventListener('click', () => {
                AppState.cancelEdit();
                this.renderPortDetails();
                this.showMessage('Edit cancelled', 'info');
            });
        } else {
            // Edit button
            document.getElementById('editBtn').addEventListener('click', () => {
                AppState.toggleEditMode();
                this.renderPortDetails();
                this.showMessage('Edit mode enabled. Make your changes and click Save.', 'info');
            });

            const switchBox = document.getElementById('switchBox');
            const switchBtn = document.getElementById('switchDataBtn');
            const switchInput = document.getElementById('switchPortInput');
            const switchSaveBtn = document.getElementById('switchSaveBtn');
            const switchCancelBtn = document.getElementById('switchCancelBtn');

            const hideSwitchBox = () => {
                switchBox.classList.remove('show');
                switchBox.setAttribute('aria-hidden', 'true');
                switchInput.value = '';
            };

            switchBtn.addEventListener('click', () => {
                switchBox.classList.toggle('show');
                const isVisible = switchBox.classList.contains('show');
                switchBox.setAttribute('aria-hidden', String(!isVisible));
                if (isVisible) {
                    switchInput.focus();
                } else {
                    switchInput.value = '';
                }
            });

            switchCancelBtn.addEventListener('click', hideSwitchBox);

            switchSaveBtn.addEventListener('click', async () => {
                const targetId = Number.parseInt(switchInput.value, 10);
                if (!Number.isFinite(targetId)) {
                    this.showMessage('Enter a valid port number.', 'info');
                    return;
                }
                if (targetId < 1 || targetId > AppState.displayCount) {
                    this.showMessage(`Port number must be between 1 and ${AppState.displayCount}.`, 'info');
                    return;
                }
                if (targetId === AppState.selectedPortId) {
                    this.showMessage('Choose a different port number to switch.', 'info');
                    return;
                }

                const ok = AppState.swapPortData(targetId);
                if (ok) {
                    const saved = await DatabaseService.saveState(AppState.ports, AppState.displayCount, AppState.extraFieldDefs);
                    if (!saved) {
                        this.showMessage('Switch completed, but failed to save to MySQL.', 'info');
                        return;
                    }
                    this.renderPortGrid();
                    this.renderPortDetails();
                    this.showMessage('Port data switched successfully!', 'success');
                } else {
                    this.showMessage('Unable to switch port data.', 'info');
                }
            });
        }
    }

    static updateFieldControlsVisibility(isEditing, hasPort) {
        const controls = document.getElementById('fieldControls');
        if (!controls) return;
        controls.hidden = !(hasPort && isEditing);
    }

    static addCustomField() {
        const port = AppState.getSelectedPort();
        if (!port) return;
        const defs = Array.isArray(AppState.extraFieldDefs) ? AppState.extraFieldDefs.slice() : [];
        const nextIndex = defs.length + 1;
        defs.push(`Field ${nextIndex}`);
        AppState.extraFieldDefs = defs;
        AppState.ports = AppState.ports.map((p) => {
            const customFields = AppState.normalizeCustomFields(p, defs);
            const newKey = defs[defs.length - 1];
            if (!Object.prototype.hasOwnProperty.call(customFields, newKey)) {
                customFields[newKey] = '';
            }
            return { ...p, customFields };
        });
        DatabaseService.saveState(AppState.ports, AppState.displayCount, AppState.extraFieldDefs);
        this.renderPortDetails();
        this.initAutoSaveListeners(port.id);
    }

    static removeCustomField() {
        const port = AppState.getSelectedPort();
        if (!port) return;
        const defs = Array.isArray(AppState.extraFieldDefs) ? AppState.extraFieldDefs.slice() : [];
        if (defs.length === 0) {
            this.showMessage('No additional fields to remove.', 'info');
            return;
        }
        const removedLabel = defs.pop();
        AppState.extraFieldDefs = defs;
        AppState.ports = AppState.ports.map((p) => {
            const customFields = AppState.normalizeCustomFields(p, defs);
            if (removedLabel && Object.prototype.hasOwnProperty.call(customFields, removedLabel)) {
                delete customFields[removedLabel];
            }
            return { ...p, customFields };
        });
        DatabaseService.saveState(AppState.ports, AppState.displayCount, AppState.extraFieldDefs);
        this.renderPortDetails();
        this.initAutoSaveListeners(port.id);
    }

    static collectExtraFieldDefsFromDom() {
        const labels = Array.from(document.querySelectorAll('.extra-field-label'));
        return labels.map((input, index) => {
            const value = input ? input.value.trim() : '';
            return value || `Field ${index + 1}`;
        });
    }

    static collectExtraFieldValuesFromDom() {
        const rows = Array.from(document.querySelectorAll('.extra-field-row'));
        const result = {};
        rows.forEach((row, index) => {
            const labelInput = row.querySelector('.extra-field-label');
            const valueInput = row.querySelector('.extra-field-value');
            const label = labelInput ? labelInput.value.trim() : `Field ${index + 1}`;
            if (!label) return;
            result[label] = valueInput ? valueInput.value : '';
        });
        return result;
    }

    static syncExtraFieldDefsFromDom() {
        const newDefs = this.collectExtraFieldDefsFromDom();
        const oldDefs = Array.isArray(AppState.extraFieldDefs) ? AppState.extraFieldDefs : [];
        const same =
            newDefs.length === oldDefs.length &&
            newDefs.every((label, index) => label === oldDefs[index]);
        if (same) {
            return { defs: newDefs, ports: AppState.ports };
        }

        const remappedPorts = AppState.ports.map((port) => {
            const existing = AppState.normalizeCustomFields(port, oldDefs);
            const customFields = {};
            newDefs.forEach((label, index) => {
                const oldLabel = oldDefs[index];
                if (oldLabel && Object.prototype.hasOwnProperty.call(existing, oldLabel)) {
                    customFields[label] = existing[oldLabel];
                } else {
                    customFields[label] = '';
                }
            });
            return { ...port, customFields };
        });

        AppState.extraFieldDefs = newDefs;
        AppState.ports = remappedPorts;
        return { defs: newDefs, ports: remappedPorts };
    }

    static savePortChanges(portId) {
        const port = AppState.getSelectedPort();
        if (!port) return;

        const updatedPort = this.collectFormValues(port);

        // Update in state
        const success = AppState.updatePort(updatedPort);
        
        if (success) {
            // Re-render UI
            this.renderPortGrid();
            this.renderPortDetails();
            
            // Show success message
            this.showMessage('Changes saved successfully!', 'success');
        } else {
            this.showMessage('Error saving changes!', 'info');
        }
    }

    static collectFormValues(port) {
        const today = new Date().toISOString().split('T')[0];
        const { defs } = this.syncExtraFieldDefsFromDom();
        const customFields = this.collectExtraFieldValuesFromDom();
        return {
            ...port,
            status: document.getElementById('statusInput').value,
            destination: document.getElementById('destinationInput').value,
            otdrDistance: document.getElementById('otdrDistanceInput').value,
            fiberType: document.getElementById('fiberTypeInput').value,
            connectorType: document.getElementById('connectorInput').value,
            branchingJoint: document.getElementById('branchingJointInput').value,
            cxLocation: document.getElementById('cxLocationInput').value,
            otdrDistanceValue: document.getElementById('otdrDistanceValueInput').value,
            // Always stamp current date when saving edits
            lastMaintained: today,
            notes: document.getElementById('notesInput').value,
            customFields: AppState.normalizeCustomFields({ customFields }, defs)
        };
    }

    static initAutoSaveListeners(portId) {
        const inputIds = [
            'statusInput',
            'destinationInput',
            'otdrDistanceInput',
            'fiberTypeInput',
            'connectorInput',
            'branchingJointInput',
            'cxLocationInput',
            'otdrDistanceValueInput',
            'notesInput'
        ];

        const onChange = () => {
            clearTimeout(UIRenderer.autoSaveTimer);
            UIRenderer.autoSaveTimer = setTimeout(() => {
                const port = AppState.getSelectedPort();
                if (!port) return;
                const updatedPort = this.collectFormValues(port);
                AppState.updatePort(updatedPort, { keepEditing: true });
            }, 600);
        };

        inputIds.forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', onChange);
            el.addEventListener('change', onChange);
        });

        const extraInputs = document.querySelectorAll('.extra-field-label, .extra-field-value');
        extraInputs.forEach((el) => {
            el.addEventListener('input', onChange);
            el.addEventListener('change', onChange);
        });
    }

    static showMessage(text, type = 'info') {
        // Remove existing message
        const existingMsg = document.querySelector('.message');
        if (existingMsg) existingMsg.remove();

        const message = document.createElement('div');
        message.className = `message ${type}`;
        message.textContent = text;
        message.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'success' ? '#2ecc71' : type === 'error' ? '#e74c3c' : '#3498db'};
            color: white;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 1000;
            animation: slideIn 0.3s ease;
            font-weight: 500;
        `;

        document.body.appendChild(message);

        setTimeout(() => {
            message.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => message.remove(), 300);
        }, 3000);
    }

    static initEventListeners() {
        // Add Port button
        document.getElementById('addPort').addEventListener('click', () => {
            if (AppState.addPort()) {
                this.renderPortGrid();
                this.showMessage('Port added successfully!', 'success');
            } else {
                this.showMessage('Maximum ports reached!', 'info');
            }
        });

        // Remove Port button
        document.getElementById('removePort').addEventListener('click', () => {
            if (AppState.removePort()) {
                this.renderPortGrid();
                this.renderPortDetails();
                this.showMessage('Port removed!', 'info');
            }
        });

        const addFieldBtn = document.getElementById('addFieldBtn');
        if (addFieldBtn) {
            addFieldBtn.addEventListener('click', () => {
                if (!AppState.isEditing) {
                    this.showMessage('Enable edit mode to add fields.', 'info');
                    return;
                }
                this.addCustomField();
            });
        }

        const removeFieldBtn = document.getElementById('removeFieldBtn');
        if (removeFieldBtn) {
            removeFieldBtn.addEventListener('click', () => {
                if (!AppState.isEditing) {
                    this.showMessage('Enable edit mode to remove fields.', 'info');
                    return;
                }
                this.removeCustomField();
            });
        }

        // Export button
        document.getElementById('exportBtn').addEventListener('click', () => {
            DatabaseService.exportData();
        });

        // Import button
        document.getElementById('importBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        // File input for import
        document.getElementById('fileInput').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const data = await DatabaseService.importData(file);
                    if (!data || !Array.isArray(data.ports) || data.ports.length === 0) {
                        this.showMessage('Import file has no valid port rows.', 'info');
                        return;
                    }

                    const defs = Array.isArray(data.extraFieldDefs) ? data.extraFieldDefs : [];
                    AppState.extraFieldDefs = defs;
                    const normalized = AppState.normalizeLoadedPorts(data.ports, data.displayCount, defs);
                    AppState.ports = normalized.ports;
                    AppState.displayCount = normalized.displayCount;
                    AppState.selectedPortId = AppState.resolveInitialPortId();
                    AppState.isEditing = false;

                    this.renderPortGrid();
                    this.renderPortDetails();

                    const saveResult = await DatabaseService.saveStateWithResult(
                        AppState.ports,
                        AppState.displayCount,
                        AppState.extraFieldDefs
                    );

                    if (!saveResult.ok) {
                        this.showMessage(`Import loaded, but MySQL save failed: ${saveResult.error}`, 'info');
                        return;
                    }

                    this.showMessage('Data imported and saved to MySQL successfully!', 'success');
                } catch (error) {
                    const message = error && error.message ? error.message : 'Error importing file!';
                    this.showMessage(message, 'info');
                }
            }
            e.target.value = ''; // Reset file input
        });

        // Save Changes button in footer
        document.getElementById('saveBtn').addEventListener('click', () => {
            (async () => {
                const ok = await DatabaseService.saveState(AppState.ports, AppState.displayCount, AppState.extraFieldDefs);
                this.showMessage(ok ? 'All data saved to MySQL storage!' : 'Save failed!', ok ? 'success' : 'info');
            })();
        });

    }
}

// ========== INITIALIZE APP ==========
document.addEventListener('DOMContentLoaded', async () => {
    const portGrid = document.getElementById('portGrid');
    if (!portGrid) {
        return;
    }

    const titleEl = document.getElementById('odfTitle');
    const subtitleEl = document.getElementById('odfSubtitle');
    if (titleEl) {
        titleEl.textContent = 'ODF Port Manager';
    }
    if (subtitleEl) {
        subtitleEl.textContent = `Region: ${ODFContext.region} | Sub ODF: ${ODFContext.sub}`;
    }

    // Initialize app state
    await AppState.init();
    
    // Render UI
    UIRenderer.renderPortGrid();
    UIRenderer.renderPortDetails();
    UIRenderer.initEventListeners();
    
    console.log('ODF Port Manager initialized successfully!');
    
    // Add CSS animations and styles
    const style = document.createElement('style');
    style.textContent = `
        @keyframes slideIn {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
            from { transform: translateX(0); opacity: 1; }
            to { transform: translateX(100%); opacity: 0; }
        }
        .port-item {
            transition: all 0.3s ease;
        }
        .readonly-text {
            padding: 8px 0;
            display: inline-block;
            color: #2c3e50;
            font-weight: 500;
        }
        .readonly-notes {
            padding: 12px;
            background: #f8f9fa;
            border-radius: 6px;
            border: 1px solid #eee;
            color: #555;
            line-height: 1.5;
            min-height: 40px;
        }
        .detail-value input, 
        .detail-value select, 
        .detail-value textarea {
            border: 2px solid #ddd;
            transition: border-color 0.3s;
        }
        .detail-value input:focus, 
        .detail-value select:focus, 
        .detail-value textarea:focus {
            border-color: #3498db;
            outline: none;
        }
        .detail-actions {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 2px solid #f0f0f0;
        }
        .switch-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            align-items: center;
        }
        .switch-box {
            margin-top: 12px;
            padding: 12px;
            border: 1px dashed #d0d0d0;
            border-radius: 8px;
            background: #fafafa;
            display: none;
        }
        .switch-box.show {
            display: block;
        }
        .switch-box label {
            display: block;
            font-weight: 600;
            margin-bottom: 6px;
            color: #2c3e50;
        }
        .switch-box input {
            width: 100%;
            max-width: 240px;
            margin-bottom: 10px;
        }
        .switch-box-actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
    `;
    document.head.appendChild(style);
});
