require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cors = require('cors');

// Use require instead of dynamic import for node-fetch
let fetch;
try {
  fetch = require('node-fetch');
} catch (e) {
  console.warn('node-fetch not available, using global fetch if available');
  fetch = globalThis.fetch || (() => {
    throw new Error('Fetch API not available');
  });
}

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

// Create WebSocket server for traffic signals
const wss = new WebSocket.Server({ server });
const pythonProcesses = new Map();

// Configure multer for file uploads
const upload = multer({ dest: path.join(__dirname, 'public', 'Incident_mapping', 'uploads') });

// Accident detection keywords
const accidentKeywords = ["accident", "crash", "collision", "pile-up"];

// ---------- Database Schema Definitions ----------
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'emergency', 'admin'], default: 'user' }
});

const incidentSchema = new mongoose.Schema({
  userId: String,
  userEmail: String,
  userName: String,
  userRole: String,
  text: String,
  location: String,
  address: String,
  filePath: String,
  fileType: String,
  accidentDetected: Boolean,
  detectionReason: String,
  timestamp: { type: Date, default: Date.now }
});

// Alert schema
const alertSchema = new mongoose.Schema({
  incidentId: String,
  type: String,
  location: String,
  address: String,
  status: { type: String, enum: ['active', 'cleared'], default: 'active' },
  timestamp: { type: Date, default: Date.now },
  clearedAt: Date
});

// ---------- Database (Mongo + file fallback) ----------
let mongoOk = false;
const usersFile = path.join(__dirname, 'data', 'users.json');
const emergencyRoutesFile = path.join(__dirname, 'data', 'emergency_routes.json');
const incidentsFile = path.join(__dirname, 'data', 'incidents.json');
const alertsFile = path.join(__dirname, 'data', 'alerts.json');

let UserModel = null;
let IncidentModel = null;
let AlertModel = null;

async function connectMongo() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.warn('[Auth] No MONGO_URI in env; using file-based user store.');
    return;
  }
  try {
    await mongoose.connect(uri, { dbName: 'traffic_auth' });
    mongoOk = true;
    UserModel = mongoose.model('User', userSchema);
    IncidentModel = mongoose.model('Incident', incidentSchema);
    AlertModel = mongoose.model('Alert', alertSchema);
    console.log('[Auth] Connected to MongoDB.');
  } catch (err) {
    console.warn('[Auth] Mongo connection failed; falling back to file store.', err.message);
    mongoOk = false;
  }
}

function ensureFilesWithDefaults() {
  const dataDir = path.dirname(usersFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  if (!fs.existsSync(usersFile)) {
    const salt = bcrypt.genSaltSync(10);
    const defaults = [
      { username: 'user', email: 'user@example.com', password: bcrypt.hashSync('123456', salt), role: 'user' },
      { username: 'emergency', email: 'emergency@example.com', password: bcrypt.hashSync('123456', salt), role: 'emergency' },
      { username: 'admin', email: 'admin@example.com', password: bcrypt.hashSync('123456', salt), role: 'admin' }
    ];
    fs.writeFileSync(usersFile, JSON.stringify(defaults, null, 2));
    console.log('[Auth] Created default users in file store.');
  }
  
  if (!fs.existsSync(emergencyRoutesFile)) {
    fs.writeFileSync(emergencyRoutesFile, JSON.stringify([], null, 2));
  }
  
  if (!fs.existsSync(incidentsFile)) {
    fs.writeFileSync(incidentsFile, JSON.stringify([], null, 2));
  }
  
  if (!fs.existsSync(alertsFile)) {
    fs.writeFileSync(alertsFile, JSON.stringify([], null, 2));
  }
}

function fileStoreReadUsers() {
  try {
    const raw = fs.readFileSync(usersFile, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function fileStoreWriteUsers(users) {
  const dataDir = path.dirname(usersFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function fileStoreReadIncidents() {
  try {
    const raw = fs.readFileSync(incidentsFile, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function fileStoreWriteIncidents(incidents) {
  const dataDir = path.dirname(incidentsFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(incidentsFile, JSON.stringify(incidents, null, 2));
}

function fileStoreReadAlerts() {
  try {
    const raw = fs.readFileSync(alertsFile, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function fileStoreWriteAlerts(alerts) {
  const dataDir = path.dirname(alertsFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(alertsFile, JSON.stringify(alerts, null, 2));
}

function fileStoreReadEmergencyRoutes() {
  try {
    const raw = fs.readFileSync(emergencyRoutesFile, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function fileStoreWriteEmergencyRoutes(routes) {
  const dataDir = path.dirname(emergencyRoutesFile);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(emergencyRoutesFile, JSON.stringify(routes, null, 2));
}

async function findUserByIdentifier(identifier) {
  if (mongoOk && UserModel) {
    // Check if identifier is email format
    const isEmail = identifier.includes('@');
    if (isEmail) {
      return await UserModel.findOne({ email: identifier.toLowerCase() });
    } else {
      return await UserModel.findOne({ username: identifier });
    }
  } else {
    const users = fileStoreReadUsers();
    return users.find(u => 
      u.username.toLowerCase() === identifier.toLowerCase() || 
      u.email.toLowerCase() === identifier.toLowerCase()
    ) || null;
  }
}

async function createUser({ username, email, password, role = 'user' }) {
  // Validate role
  const validRoles = ['user', 'emergency', 'admin'];
  if (!validRoles.includes(role)) {
    role = 'user'; // Default to user if invalid role provided
  }
  
  const hash = await bcrypt.hash(password, 10);
  if (mongoOk && UserModel) {
    return await UserModel.create({ username, email, password: hash, role });
  } else {
    const users = fileStoreReadUsers();
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      throw new Error('User already exists');
    }
    users.push({ username, email, password: hash, role });
    fileStoreWriteUsers(users);
    return { username, email, role };
  }
}

async function saveIncident(incidentData) {
  if (mongoOk && IncidentModel) {
    return await IncidentModel.create(incidentData);
  } else {
    const incidents = fileStoreReadIncidents();
    incidents.push({ ...incidentData, _id: Date.now().toString() });
    fileStoreWriteIncidents(incidents);
    return incidentData;
  }
}

async function getIncidents() {
  if (mongoOk && IncidentModel) {
    return await IncidentModel.find().sort({ timestamp: -1 });
  } else {
    return fileStoreReadIncidents();
  }
}

async function saveAlert(alertData) {
  if (mongoOk && AlertModel) {
    return await AlertModel.create(alertData);
  } else {
    const alerts = fileStoreReadAlerts();
    alerts.push({ ...alertData, _id: Date.now().toString() });
    fileStoreWriteAlerts(alerts);
    return alertData;
  }
}

async function getAlerts(status = null) {
  if (mongoOk && AlertModel) {
    const query = status ? { status } : {};
    return await AlertModel.find(query).sort({ timestamp: -1 });
  } else {
    const alerts = fileStoreReadAlerts();
    if (status) {
      return alerts.filter(alert => alert.status === status);
    }
    return alerts;
  }
}

async function updateAlert(id, updateData) {
  if (mongoOk && AlertModel) {
    return await AlertModel.findByIdAndUpdate(id, updateData, { new: true });
  } else {
    const alerts = fileStoreReadAlerts();
    const index = alerts.findIndex(alert => alert._id === id);
    if (index !== -1) {
      alerts[index] = { ...alerts[index], ...updateData };
      fileStoreWriteAlerts(alerts);
      return alerts[index];
    }
    return null;
  }
}

// ---------- Traffic Signal Functions ----------
async function readSignalCSV() {
  try {
    const signalsPath = path.join(__dirname, 'public', 'signal.csv');
    const csvData = fs.readFileSync(signalsPath, 'utf-8');
    const lines = csvData.split('\n');
    const headers = lines[0].split(',');
    const signals = lines.slice(1).map(line => {
      const values = line.split(',');
      return headers.reduce((obj, header, i) => {
        obj[header.trim()] = values[i]?.trim();
        return obj;
      }, {});
    }).filter(signal => signal.SL_No && signal.Name);
    
    return signals;
  } catch (e) {
    console.error('Failed to read signal CSV:', e);
    return [];
  }
}

function parseDMS(coord) {
  if (!coord) return 0;
  
  const parts = coord.split(/[°'"\s]+/).filter(p => p);
  if (parts.length < 4) return 0;
  
  const degrees = parseFloat(parts[0]);
  const minutes = parseFloat(parts[1]);
  const seconds = parseFloat(parts[2]);
  const direction = parts[3];
  
  let dd = degrees + minutes/60 + seconds/3600;
  if (direction === 'S' || direction === 'W') dd *= -1;
  return dd;
}

function startTrafficSignalProcess(signal) {
  const crossingName = `Crossing_${signal.SL_No}`;
  const pythonDir = path.join(__dirname, 'python');
  
  // Check if crossing directory exists
  const crossingPath = path.join(pythonDir, 'All_Crossings', crossingName);
  if (!fs.existsSync(crossingPath)) {
    console.warn(`Crossing directory not found: ${crossingPath}`);
    return null;
  }
  
  // Start the traffic.py process for this signal
  const trafficProcess = spawn(PYTHON_PATH, ['traffic.py', crossingName], {
    cwd: pythonDir,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  trafficProcess.stdout.on('data', (data) => {
    try {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          try {
            const signalData = JSON.parse(line);
            // Broadcast to all connected WebSocket clients
            const message = JSON.stringify({
              type: 'signal_update',
              signal_id: signal.SL_No,
              data: signalData
            });
            
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(message);
              }
            });
          } catch (e) {
            console.error('Error parsing traffic signal data:', e, line);
          }
        }
      });
    } catch (e) {
      console.error('Error processing traffic signal output:', e);
    }
  });
  
  trafficProcess.stderr.on('data', (data) => {
    console.error(`Traffic signal ${signal.SL_No} error: ${data}`);
  });
  
  trafficProcess.on('close', (code) => {
    console.log(`Traffic signal ${signal.SL_No} process exited with code ${code}`);
    // Restart the process after a delay
    setTimeout(() => {
      console.log(`Restarting traffic signal ${signal.SL_No}`);
      pythonProcesses.set(signal.SL_No, startTrafficSignalProcess(signal));
    }, 5000);
  });
  
  return trafficProcess;
}

// ---------- WebSocket Connection Handling ----------
wss.on('connection', function connection(ws) {
  console.log('Client connected to traffic signal WebSocket');
  
  // Send initial signal data to the client
  readSignalCSV().then(signals => {
    const signalData = signals.map(signal => ({
      id: signal.SL_No,
      name: signal.Name,
      lat: parseDMS(signal.Latitude),
      lng: parseDMS(signal.Longitude)
    }));
    
    ws.send(JSON.stringify({
      type: 'initial_signals',
      signals: signalData
    }));
  });
  
  ws.on('close', function() {
    console.log('Client disconnected from traffic signal WebSocket');
  });
  
  ws.on('error', function(error) {
    console.error('WebSocket error:', error);
  });
});

// ---------- Middleware ----------
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

function adminRequired(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'unauthorized' });
    }
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'invalid_token' });
  }
}

// ---------- Accident Detection Functions ----------
function containsAccidentWords(text) {
  const lowerText = text.toLowerCase();
  return accidentKeywords.some(word => lowerText.includes(word));
}

async function reverseGeocode(location) {
  try {
    if (!location) return null;
    const [lat, lon] = location.split(",");
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`;
    
    // Use fetch with proper error handling
    let response;
    try {
      response = await fetch(url, { 
        headers: { "User-Agent": "AccidentReporter/1.0" } 
      });
    } catch (fetchError) {
      console.error("Fetch error in reverseGeocode:", fetchError);
      return location; // Return original location if fetch fails
    }
    
    if (!response.ok) {
      console.error("Reverse geocode API error:", response.status, response.statusText);
      return location;
    }
    
    const data = await response.json();
    return data.display_name || `${lat}, ${lon}`;
  } catch (err) {
    console.error("Reverse geocode error:", err);
    return location;
  }
}

// ---------- Auth routes ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password) 
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    
    const user = await createUser({ username, email, password, role: role || 'user' });
    return res.json({ ok: true, user: { username: user.username, email: user.email, role: user.role } });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { usernameOrEmail, password } = req.body;
    const user = await findUserByIdentifier(usernameOrEmail);
    if (!user) return res.status(401).json({ ok: false, error: 'invalid_credentials' });
    const passOk = await bcrypt.compare(password, user.password);
    if (!passOk) return res.status(401).json({ ok: false, error: 'invalid_credentials' });

    const payload = { email: user.email, role: user.role || 'user' };
    const token = signToken(payload);
    res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7*24*3600*1000 });
    return res.json({ ok: true, role: payload.role });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'login_failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  return res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ auth: false });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ auth: true, user: { email: payload.email, role: payload.role } });
  } catch {
    return res.json({ auth: false });
  }
});

// ---------- Incident Reporting Routes ----------
app.post('/api/incident/report', authRequired, upload.single("file"), async (req, res) => {
  try {
    let alertTriggered = false;
    let detectionReason = "no_accident_detected";
    let fileType = req.file ? req.file.mimetype : null;
    let location = req.body.location || null;

    const userEmail = req.user.email;
    const userRole = req.user.role;

    const user = await findUserByIdentifier(userEmail);
    const userName = user ? user.username : userEmail.split('@')[0];

    // 1️⃣ Text check
    if (req.body.text && containsAccidentWords(req.body.text)) {
      alertTriggered = true;
      detectionReason = "text_keywords";
    }

    // 2️⃣ Image detection with YOLO
    if (fileType && fileType.startsWith("image/")) {
      console.log("Image received, running YOLO detection...");
      try {
        const imgPath = path.resolve(req.file.path);
        const detectScriptPath = path.join(__dirname, 'public', 'Incident_mapping', 'detect_accident.py');
        const py = spawn("python", [detectScriptPath, imgPath], { env: { ...process.env } });

        let stdout = "", stderr = "";
        py.stdout.on("data", (data) => { stdout += data.toString(); });
        py.stderr.on("data", (data) => { stderr += data.toString(); });

        const exitCode = await new Promise((resolve) => py.on("close", resolve));
        if (exitCode !== 0) {
          return res.status(500).json({ status: "Error in image detection", error: stderr || stdout });
        }

        let result = JSON.parse(stdout);
        if (result.accident) {
          alertTriggered = true;
          detectionReason = result.info.reason;
        }
      } catch (err) {
        console.error("Image detection failed:", err);
        // Continue even if detection fails
      }
    }

    // Save incident to database
    const address = await reverseGeocode(location);
    const incidentData = {
      userId: userEmail,
      userEmail: userEmail,
      userName: userName,
      userRole: userRole,
      text: req.body.text || "",
      location: location,
      address: address,
      filePath: req.file ? req.file.path : null,
      fileType: fileType,
      accidentDetected: alertTriggered,
      detectionReason: detectionReason
    };

    await saveIncident(incidentData);

    if (alertTriggered) {
      // Broadcast to admin dashboard via WebSocket
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'incident_alert',
            data: incidentData
          }));
        }
      });
      
      return res.json({ status: "Incident reported and alert sent to admin" });
    } else {
      return res.json({ status: "Incident reported (no accident detected)" });
    }

  } catch (err) {
    return res.status(500).json({ status: "Server error", error: err.message });
  }
});

app.get('/api/incident/list', authRequired, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'unauthorized' });
    }
    
    const incidents = await getIncidents();
    return res.json({ ok: true, incidents });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Alert Management Routes ----------
app.post('/api/alert/send', adminRequired, async (req, res) => {
  try {
    const { incidentId, type, location, address } = req.body;
    
    if (!incidentId || !type || !location) {
      return res.status(400).json({ ok: false, error: 'missing_fields' });
    }
    
    const alertData = {
      incidentId,
      type,
      location,
      address: address || location,
      status: 'active'
    };
    
    const alert = await saveAlert(alertData);
    
    // Broadcast alert to all connected clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'new_alert',
          data: alert
        }));
      }
    });
    
    return res.json({ ok: true, alert });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/alert/clear/:id', adminRequired, async (req, res) => {
  try {
    const { id } = req.params;
    
    const updatedAlert = await updateAlert(id, { 
      status: 'cleared', 
      clearedAt: new Date() 
    });
    
    if (!updatedAlert) {
      return res.status(404).json({ ok: false, error: 'alert_not_found' });
    }
    
    // Broadcast alert clearance to all connected clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'alert_cleared',
          data: updatedAlert
        }));
      }
    });
    
    return res.json({ ok: true, alert: updatedAlert });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/alert/active', authRequired, async (req, res) => {
  try {
    const alerts = await getAlerts('active');
    return res.json({ ok: true, alerts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/alert/all', adminRequired, async (req, res) => {
  try {
    const alerts = await getAlerts();
    return res.json({ ok: true, alerts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/notifications', authRequired, async (req, res) => {
  try {
    // For now, return all alerts - in a real app you might want to filter by user preferences
    const alerts = await getAlerts();
    return res.json({ ok: true, notifications: alerts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Route signals handling (Node -> Python) ----------
const pythonDir = path.join(__dirname, 'python');

function writeRouteSignalCSV(routeArray) {
  const csvPath = path.join(pythonDir, 'routeSignal.csv');
  const header = 'route,signal_serial_numbers,distance_time\n';
  const rows = routeArray.map(r => {
    // r: {route, signal_count, signal_serial_numbers, distance_time}
    const route = (r.route || '').replace(/"/g, '');
    const sigs = (r.signal_serial_numbers || '').replace(/"/g, '');
    const dt = (r.distance_time || '').replace(/"/g, '');
    return `"${route}","${sigs}","${dt}"`;
  }).join('\n');
  fs.writeFileSync(csvPath, header + rows, 'utf-8');
  return csvPath;
}

function runPythonMainAlgo() {
  return new Promise((resolve, reject) => {
    const script = path.join(pythonDir, 'mainAlgo.py');
    
    // Use spawn with buffer instead of waiting for file write/read
    const child = spawn(PYTHON_PATH, [script], { 
      cwd: pythonDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    // Listen for stdout data
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    // Listen for stderr data
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        try {
          // Try to parse the JSON output from stdout
          const json = JSON.parse(stdout);
          resolve({ code, stderr, json });
        } catch (e) {
          // Fallback to reading from file if stdout doesn't contain JSON
          const outPath = path.join(pythonDir, 'fastest_route.json');
          try {
            const text = fs.readFileSync(outPath, 'utf-8');
            const json = JSON.parse(text);
            resolve({ code, stderr, json });
          } catch (fileError) {
            reject(new Error('Failed to parse output. ' + e.message + '\n' + stderr));
          }
        }
      } else {
        reject(new Error(`Python script exited with code ${code}. ${stderr}`));
      }
    });
    
    // End the stdin stream to let the Python script know input is complete
    child.stdin.end();
  });
}

app.post('/saveRouteSignals', authRequired, async (req, res) => {
  try {
    const routes = req.body;
    const userRole = req.user.role;
    
    if (!Array.isArray(routes) || routes.length === 0) {
      return res.status(400).json({ success: false, error: 'invalid_payload' });
    }
    
    writeRouteSignalCSV(routes);
    const result = await runPythonMainAlgo();
    
    // Broadcast to WebSocket clients
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'route_update',
          data: result.json
        }));
      }
    });
    
    // Store emergency routes separately
    if (userRole === 'emergency') {
      const emergencyRoutes = fileStoreReadEmergencyRoutes();
      const timestamp = new Date().toISOString();
      const userEmail = req.user.email;
      
      emergencyRoutes.push({
        timestamp,
        user: userEmail,
        routes: routes,
        result: result.json
      });
      
      fileStoreWriteEmergencyRoutes(emergencyRoutes);
    }
    
    return res.json({ success: true, result: result.json, stderr: result.stderr });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Add API endpoint to get emergency routes history
app.get('/api/emergency/routes', authRequired, (req, res) => {
  if (req.user.role !== 'emergency' && req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'unauthorized' });
  }
  
  try {
    const emergencyRoutes = fileStoreReadEmergencyRoutes();
    return res.json({ ok: true, routes: emergencyRoutes });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'failed_to_read_routes' });
  }
});

// Add API endpoint to get all signals data
app.get('/api/signals', authRequired, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'unauthorized' });
  }
  
  try {
    const signalsPath = path.join(__dirname, 'public', 'signal.csv');
    const csvData = fs.readFileSync(signalsPath, 'utf-8');
    const lines = csvData.split('\n');
    const headers = lines[0].split(',');
    const signals = lines.slice(1).map(line => {
      const values = line.split(',');
      return headers.reduce((obj, header, i) => {
        obj[header.trim()] = values[i]?.trim();
        return obj;
      }, {});
    }).filter(signal => signal.SL_No && signal.Name);
    
    return res.json({ ok: true, signals });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'failed_to_read_signals' });
  }
});

// ---------- Role-based page routing (optional server-side guards) ----------
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

app.get('/admin/incident_page', adminRequired, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin', 'incident_page.html'));
});

app.get('/emergency', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'emergency', 'index.html'));
});

app.get('/incident', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'Incident_mapping', 'index.html'));
});

// Fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Start ----------
(async () => {
  await connectMongo();
  if (!mongoOk) {
    ensureFilesWithDefaults();
  }

  // Start traffic signal processes
  const signals = await readSignalCSV();
  signals.forEach(signal => {
    pythonProcesses.set(signal.SL_No, startTrafficSignalProcess(signal));
  });

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
    console.log(`Started ${pythonProcesses.size} traffic signal processes`);
  });
})();