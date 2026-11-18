const vscode = require('vscode');
const { createServer } = require('node:http');
const { lstatSync, mkdirSync, mkdtempSync, rmdirSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { runCommand } = require('./run');

const requestSerial = (...args) => vscode.commands.executeCommand('serialTerminalShare.request', ...args);
const running = new Set();

const api = {
    endpoints: {
        'GET /ports': 'List Windows serial devices and their open status.',
        'POST /open': 'Open in the background. Optional port and config (default 115200n81).',
        'POST /close': 'Close a terminal opened by /open and release the port.',
        'GET /buffer': 'Read raw bytes. Use tail (lines) and limit (bytes), or pass X-Serial-Cursor as after with an optional limit. Check X-Serial-More and X-Serial-Missed-Bytes.',
        'GET /stream': 'Follow raw serial output.',
        'POST /input': 'Send application/octet-stream. Set enter=1 to append CR.',
        'POST /run': 'Send one text/plain line to an active POSIX shell. timeout is in seconds, limit in bytes. Returns status, output and exitCode.',
    },
    port: 'Use port=COM4 when needed. Omit it when there is only one candidate.',
    examples: [
        'curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" "http://localhost/buffer?tail=40&limit=4096"',
        'curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" -H "Content-Type: text/plain" --data-binary "uname -a" "http://localhost/run?timeout=5&limit=2048"',
    ],
};

function positiveInteger(params, name) {
    const value = params.get(name);
    if (value === null) {
        return undefined;
    }
    const number = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 ? number : NaN;
}

async function readBuffer(port, params, response) {
    const tail = positiveInteger(params, 'tail');
    const limit = positiveInteger(params, 'limit');
    const after = params.get('after');
    const match = after?.match(/^([0-9a-f-]{36}):(\d+)$/);
    const cursor = match ? Number(match[2]) : undefined;
    if (Number.isNaN(tail) || Number.isNaN(limit)
        || (after !== null && (!Number.isSafeInteger(cursor) || tail !== undefined))) {
        response.writeHead(400).end('Use positive integers for tail and limit, or a cursor in after without tail.\n');
        return;
    }
    const result = await requestSerial('read', port, cursor, match?.[1], { tail, limit });
    if (!result) {
        if (after !== null) {
            response.writeHead(409).end('Serial cursor expired. Read the buffer again without after.\n');
        } else {
            response.writeHead(404).end('Serial port is not open\n');
        }
        return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('X-Serial-Cursor', `${result.session}:${result.cursor}`);
    response.setHeader('X-Serial-Missed-Bytes', result.missed);
    response.setHeader('X-Serial-More', result.more ? '1' : '0');
    response.end(Buffer.from(result.data, 'base64'));
}

async function writeInput(port, url, request, response) {
    const run = url.pathname === '/run';
    const enter = url.searchParams.get('enter');
    const timeout = positiveInteger(url.searchParams, 'timeout') ?? 10;
    const limit = positiveInteger(url.searchParams, 'limit') ?? 4096;
    if (run && (!Number.isFinite(timeout) || timeout > 120 || !Number.isFinite(limit) || limit > 256 * 1024)) {
        response.writeHead(400).end('Use timeout in seconds (1–120) and limit in bytes (1–262144).\n');
        return;
    }
    if (!run && enter !== null && enter !== '1') {
        response.writeHead(400).end('Use enter=1 to append carriage return.\n');
        return;
    }
    const length = Number(request.headers['content-length']);
    const type = run ? 'text/plain' : 'application/octet-stream';
    const max = !run && enter === '1' ? 4095 : 4096;
    const min = !run && enter === '1' ? 0 : 1;
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== type
        || !Number.isInteger(length) || length < min || length > max) {
        response.writeHead(400).end('Expected ' + min + ' to ' + max + ' bytes of ' + type + '.\n');
        return;
    }
    const chunks = [];
    for await (const chunk of request) {
        chunks.push(chunk);
    }
    if (running.has(port)) {
        response.writeHead(409).end('A shell command is already running on this serial port.\n');
        return;
    }
    if (!run) {
        if (enter === '1') {
            chunks.push(Buffer.from('\r'));
        }
        const written = await requestSerial('input', port, Buffer.concat(chunks).toString('base64'));
        response.writeHead(written ? 204 : 409).end();
        return;
    }

    let command;
    try {
        command = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
        response.writeHead(400).end('Expected a UTF-8 shell command.\n');
        return;
    }
    if (!command.trim() || /[\x00-\x1f\x7f]/.test(command)) {
        response.writeHead(400).end('Expected a single-line shell command without control characters.\n');
        return;
    }
    running.add(port);
    try {
        const result = await runCommand(requestSerial, port, command, timeout, limit);
        if (!result) {
            response.writeHead(409).end('Serial port unavailable. Open it in the current version of Serial Terminal Share.\n');
        } else if (result.error) {
            response.writeHead(400).end(result.error + '\n');
        } else {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify(result) + '\n');
        }
    } finally {
        running.delete(port);
    }
}

async function handleRequest(request, response) {
    if (request.headers.origin || request.headers.host !== 'localhost') {
        response.writeHead(403).end();
        return;
    }
    if (!request.url?.startsWith('/')) {
        response.writeHead(400).end();
        return;
    }
    const url = new URL('http://localhost' + request.url);
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && url.pathname === '/') {
        const workspaceFolders = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ workspaceFolders, ...api }) + '\n');
        return;
    }
    if (request.method === 'GET' && url.pathname === '/ports') {
        const devices = await requestSerial('devices');
        if (!devices) {
            response.writeHead(503).end('Update Serial Terminal Share on Windows to list serial devices.\n');
            return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(devices) + '\n');
        return;
    }
    if (request.method === 'POST' && url.pathname === '/open') {
        const result = await requestSerial('open', url.searchParams.get('port'), url.searchParams.get('config'));
        if (!result) {
            response.writeHead(503).end('Update Serial Terminal Share on Windows to open a serial port.\n');
            return;
        }
        const { status, ...body } = result;
        response.setHeader('Content-Type', 'application/json');
        response.writeHead(status).end(JSON.stringify(body) + '\n');
        return;
    }
    const read = request.method === 'GET' && (url.pathname === '/buffer' || url.pathname === '/stream');
    const write = request.method === 'POST' && (url.pathname === '/input' || url.pathname === '/run');
    const close = request.method === 'POST' && url.pathname === '/close';
    if (!read && !write && !close) {
        response.writeHead(404).end();
        return;
    }
    let port = url.searchParams.get('port');
    if (port === '') {
        response.writeHead(400).end('Specify a serial port from /ports.\n');
        return;
    }
    if (port === null) {
        const ports = await requestSerial('ports');
        if (ports.length !== 1) {
            response.writeHead(ports.length ? 409 : 404)
                .end(ports.length ? 'Specify a serial port from /ports.\n' : 'No serial ports are open.\n');
            return;
        }
        [port] = ports;
    }
    if (close) {
        const result = await requestSerial('close', port);
        if (!result) {
            response.writeHead(503).end('Update Serial Terminal Share on Windows to close a serial port.\n');
            return;
        }
        response.writeHead(result.status).end(result.error ? result.error + '\n' : undefined);
    } else if (write) {
        await writeInput(port, url, request, response);
    } else if (url.pathname === '/buffer') {
        await readBuffer(port, url.searchParams, response);
    } else {
        let result = await requestSerial('read', port);
        if (!result) {
            response.writeHead(404).end('Serial port is not open\n');
            return;
        }
        response.setHeader('Content-Type', 'application/octet-stream');
        response.flushHeaders();
        while (result && !response.destroyed) {
            if (result.missed) {
                response.destroy();
                return;
            }
            if (result.data) {
                const data = Buffer.from(result.data, 'base64');
                if (response.writableLength + data.length > 512 * 1024) {
                    response.destroy();
                    return;
                }
                response.write(data);
            }
            await delay(200);
            if (response.destroyed) {
                return;
            }
            result = await requestSerial('read', port, result.cursor, result.session);
        }
        response.end();
    }
}

function createSocketDirectory() {
    const uid = process.getuid();
    const base = '/tmp/serialterminal-share';
    mkdirSync(base, { recursive: true, mode: 0o755 });
    const parent = lstatSync(base);
    if (!parent.isDirectory() || (parent.uid !== uid && parent.uid !== 0)
        || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) {
        throw new Error(`Unsafe serial socket directory: ${base}`);
    }

    return mkdtempSync(join(base, `${uid}-`));
}

function activate(context) {
    if (vscode.env.remoteName !== 'ssh-remote' || process.platform === 'win32') {
        return;
    }
    const directory = createSocketDirectory();
    const socketPath = join(directory, 'serial.sock');
    const sockets = new Set();
    const server = createServer((request, response) => {
        handleRequest(request, response).catch(error => {
            if (response.headersSent || response.destroyed) {
                response.destroy();
            } else {
                response.writeHead(503).end(`Serial Terminal Share is unavailable: ${error.message}\n`);
            }
        });
    });
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.on('error', error => console.error('Serial Terminal Share Remote:', error));
    server.listen(socketPath, () => {
        context.environmentVariableCollection.replace('SERIAL_TERMINAL_SHARE_SOCKET', socketPath);
    });
    context.subscriptions.push({
        dispose() {
            context.environmentVariableCollection.clear();
            server.close(() => {
                try {
                    rmdirSync(directory);
                } catch (error) {
                    console.error('Serial Terminal Share Remote:', error);
                }
            });
            for (const socket of sockets) {
                socket.destroy();
            }
        },
    });
}

module.exports = { activate };
