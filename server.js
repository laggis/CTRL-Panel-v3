const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs');
const app = express();
const port = 3000;

// Path to data files
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

const SCRIPTS_FILE = path.join(DATA_DIR, 'scripts.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// Initialize storage
let storage = {
    scripts: [],
    history: []
};

let users = {
    users: []
};

// Load existing data
if (fs.existsSync(SCRIPTS_FILE)) {
    try {
        storage = JSON.parse(fs.readFileSync(SCRIPTS_FILE, 'utf8'));
    } catch (error) {
        console.error('Error loading scripts file:', error);
    }
}

if (fs.existsSync(USERS_FILE)) {
    try {
        users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (error) {
        console.error('Error loading users file:', error);
    }
}

// Save functions
function saveStorage() {
    try {
        fs.writeFileSync(SCRIPTS_FILE, JSON.stringify(storage, null, 2));
    } catch (error) {
        console.error('Error saving scripts file:', error);
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error('Error saving users file:', error);
    }
}

app.use(express.json());
app.use(express.static('public'));
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// Store running processes
const processes = new Map();

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Admin middleware
const requireAdmin = (req, res, next) => {
    if (req.session.authenticated && req.session.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
};

// Serve login page
app.get('/login', (req, res) => {
    if (req.session.authenticated) {
        res.redirect('/');
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Handle login
app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = users.users.find(u => u.username === username);
    
    if (user && await bcrypt.compare(password, user.password)) {
        req.session.authenticated = true;
        req.session.username = username;
        req.session.role = user.role;
        res.json({ success: true, role: user.role });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// Handle logout
app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Change password
app.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = users.users.find(u => u.username === req.session.username);

    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    try {
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        saveUsers();

        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error changing password' });
    }
});

// Add new user (admin only)
app.post('/users', requireAdmin, async (req, res) => {
    const { username, password, role } = req.body;

    if (users.users.some(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            username,
            password: hashedPassword,
            role: role || 'user',
            createdAt: new Date().toISOString()
        };

        users.users.push(newUser);
        saveUsers();

        res.json({ success: true, message: 'User created successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Error creating user' });
    }
});

// Get users (admin only)
app.get('/users', requireAdmin, (req, res) => {
    const safeUsers = users.users.map(({ username, role, createdAt }) => ({
        username,
        role,
        createdAt
    }));
    res.json(safeUsers);
});

// Delete user (admin only)
app.delete('/users/:username', requireAdmin, (req, res) => {
    const { username } = req.params;
    
    if (username === 'admin') {
        return res.status(400).json({ error: 'Cannot delete admin user' });
    }

    const initialLength = users.users.length;
    users.users = users.users.filter(u => u.username !== username);

    if (users.users.length === initialLength) {
        return res.status(404).json({ error: 'User not found' });
    }

    saveUsers();
    res.json({ success: true, message: 'User deleted successfully' });
});

// Main dashboard - protected by authentication
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Start all saved scripts on server start
function startSavedScripts() {
    storage.scripts.forEach(script => {
        if (script.status === 'running') {
            try {
                const process = spawn(script.type === 'python' ? 'python' : 'node', [script.path]);
                processes.set(script.name, process);

                process.stdout.on('data', (data) => {
                    console.log(`${script.name} stdout: ${data}`);
                });

                process.stderr.on('data', (data) => {
                    console.error(`${script.name} stderr: ${data}`);
                });

                process.on('close', (code) => {
                    console.log(`${script.name} exited with code ${code}`);
                    processes.delete(script.name);
                    const scriptIndex = storage.scripts.findIndex(s => s.name === script.name);
                    if (scriptIndex !== -1) {
                        storage.scripts[scriptIndex].status = 'stopped';
                        saveStorage();
                    }
                });
            } catch (error) {
                console.error(`Error starting saved script ${script.name}:`, error);
            }
        }
    });
}

// API endpoints - all protected by authentication
app.post('/start', requireAuth, (req, res) => {
    const { name, command, type } = req.body;
    
    if (processes.has(name)) {
        return res.status(400).json({ error: 'Process already running' });
    }

    try {
        const process = spawn(type === 'python' ? 'python' : 'node', [command]);
        processes.set(name, process);
        
        // Add to storage
        const scriptData = {
            name,
            path: command,
            type,
            startTime: new Date().toISOString(),
            status: 'running'
        };

        const existingIndex = storage.scripts.findIndex(s => s.name === name);
        if (existingIndex !== -1) {
            storage.scripts[existingIndex] = scriptData;
        } else {
            storage.scripts.push(scriptData);
        }

        storage.history.push({
            ...scriptData,
            action: 'started'
        });

        saveStorage();

        process.stdout.on('data', (data) => {
            console.log(`${name} stdout: ${data}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`${name} stderr: ${data}`);
        });

        process.on('close', (code) => {
            console.log(`${name} exited with code ${code}`);
            processes.delete(name);
            const scriptIndex = storage.scripts.findIndex(s => s.name === name);
            if (scriptIndex !== -1) {
                storage.scripts[scriptIndex].status = 'stopped';
                storage.scripts[scriptIndex].endTime = new Date().toISOString();
                storage.history.push({
                    ...storage.scripts[scriptIndex],
                    action: 'stopped'
                });
                saveStorage();
            }
        });

        res.json({ success: true, message: `${name} started successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/stop', requireAuth, (req, res) => {
    const { name } = req.body;
    const process = processes.get(name);

    if (!process) {
        return res.status(404).json({ error: 'Process not found' });
    }

    try {
        process.kill();
        processes.delete(name);
        
        const scriptIndex = storage.scripts.findIndex(s => s.name === name);
        if (scriptIndex !== -1) {
            storage.scripts[scriptIndex].status = 'stopped';
            storage.scripts[scriptIndex].endTime = new Date().toISOString();
            storage.history.push({
                ...storage.scripts[scriptIndex],
                action: 'stopped'
            });
            saveStorage();
        }

        res.json({ success: true, message: `${name} stopped successfully` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/status', requireAuth, (req, res) => {
    const status = storage.scripts.map(script => ({
        ...script,
        isRunning: processes.has(script.name)
    }));
    res.json(status);
});

app.get('/history', requireAuth, (req, res) => {
    res.json(storage.history);
});

app.delete('/history/:name', requireAuth, (req, res) => {
    const { name } = req.params;
    if (processes.has(name)) {
        return res.status(400).json({ error: 'Cannot delete running script' });
    }

    storage.scripts = storage.scripts.filter(script => script.name !== name);
    storage.history = storage.history.filter(entry => entry.name !== name);
    saveStorage();

    res.json({ success: true });
});

// Start saved scripts when server starts
startSavedScripts();

app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
});
