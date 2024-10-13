const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { spawn } = require('child_process');
const moment = require('moment');
const archiver = require('archiver');

const app = express();
const PORT = 80;

let isServerRunning = false;
let serverOutput = '';
let serverPID = '';
let serverStartTime = '';
let serverStartBy = '';
let clients = [];

app.use(cors({
    origin: ['http://localhost:3000', 'http://192.168.10.65'],
    credentials: true
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
    session({
        secret: 'minecraft-server',
        resave: false,
        saveUninitialized: true,
        cookie: { 
            secure: false
        }
    })
);

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    fs.readFile('users.json', 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ message: 'Server error' });
        }

        const users = JSON.parse(data);
        const user = users.find(user => user.username === username && user.password === password);

        if (user) {
            req.session.isAuthenticated = true;
            req.session.user = username;
            return res.json({ message: 'Login successful!' });
        } else {
            return res.json({ message: 'Invalid username or password' });
        }
    });
});

app.get('/check-auth', (req, res) => {
    if (req.session.isAuthenticated) {
        res.json({ isAuthenticated: true });
    } else {
        res.json({ isAuthenticated: false });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ message: 'Unable to log out' });
        }
        res.json({ message: 'Logout successful!' });
    });
});

app.get('/check-status', (req, res) => {
    if (req.session.isAuthenticated) {
        res.json({ isRunning: isServerRunning, serverPID: serverPID, serverStartTime: serverStartTime, serverStartBy: serverStartBy});
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.post('/start-server', (req, res) => {
    if (req.session.isAuthenticated) {
        if (!isServerRunning) {
            isServerRunning = true;
            serverOutput = '';
            serverStartTime = moment().format('YYYY-MM-DD HH:mm:ss');
            serverStartBy = req.session.user;

            const dirPath = path.join('/minecraft');
            const bashCommand = '/bin/bash';
            const args = ['-u', '/minecraft/run.sh'];
            const serverProcess = spawn(bashCommand, args, { cwd: dirPath });
            serverPID = serverProcess.pid;
            serverOutput = `[Server started at ${serverStartTime} with PID ${serverPID} by ${serverStartBy}]\n`
            
            serverProcess.stdout.on('data', (data) => {
                serverOutput += data.toString('utf8');
                clients.forEach((client) => {
                    client.write(`data: ${data.toString('utf8')}\n\n`);
                });
            });

            serverProcess.on('close', (code) => {
                serverOutput += `[Process exited with code ${code}]`;
                clients.forEach((client) => {
                    client.write(`event: end\ndata:[Process exited with code ${code}]\n\n`);
                    client.end();
                });
            });

            serverProcess.stderr.on('data', (data) => {
                clients.forEach((client) => {
                    client.write(`data: Error: ${data.toString('utf8')}\n\n`);
                });
            });

            res.json({ message: 'OK', isRunning: isServerRunning, serverPID: serverPID, serverStartTime: serverStartTime, serverStartBy: serverStartBy});
        } else {
            res.json({ message: 'ERROR', isRunning: isServerRunning, serverPID: serverPID, serverStartTime: serverStartTime, serverStartBy: serverStartBy});
        }
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.post('/stop-server', (req, res) => {
    if (req.session.isAuthenticated) {
        if (isServerRunning) {
            isServerRunning = false;
            const dirPath = path.join('/minecraft');
            const mcrconCommand = 'mcrcon';
            const args = ['-H', '127.0.0.1', '-P', '25575', '-p', 'qpwoeiru', 'stop'];
            spawn(mcrconCommand, args, { cwd: dirPath });
            
            serverPID = '';
            serverStartTime = '';
        }
        
        res.json({ isRunning: isServerRunning });
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.get('/stream-output', (req, res) => {
    if (req.session.isAuthenticated) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        clients.push(res);
        const lines = serverOutput.split('\n');
        lines.forEach(line => {
            if (line) {
                res.write(`data: ${line}\n\n`);
            }
        });

        req.on('close', () => {
            clients = clients.filter((client) => client !== res);
        });
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.get('/history-output', (req, res) => {
    if (req.session.isAuthenticated) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const lines = serverOutput.split('\n');
        lines.forEach(line => {
            if (line) {
                res.write(`data: ${line}\n\n`);
            }
        });

        res.write('event: end\n');
        res.end();
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.get('/download-zip', (req, res) => {
    if (req.session.isAuthenticated) {
        const folderToZip = path.join('/minecraft/world');
        const outputFilePath = path.join(__dirname, 'minecraft-world.zip');
        const output = fs.createWriteStream(outputFilePath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => {
            res.download(outputFilePath, 'minecraft-world.zip', (err) => {
                if (err) {
                    console.error('Error during download:', err);
                }
            });
        });

        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(output);
        archive.directory(folderToZip, false);
        archive.finalize();
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
});

app.use(express.static(path.join(__dirname, '../frontend/build')));

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
