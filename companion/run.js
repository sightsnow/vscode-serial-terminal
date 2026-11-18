const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

class CommandOutput {
    chunks = [];
    size = 0;
    omitted = 0;
    pending = Buffer.alloc(0);
    started = false;

    constructor(marker, limit) {
        this.start = Buffer.from('\x1e' + marker + 'S');
        this.end = Buffer.from('\x1e' + marker + 'E:');
        this.limit = limit;
    }

    capture(data) {
        const size = Math.min(data.length, this.limit - this.size);
        if (size) {
            this.chunks.push(Buffer.from(data.subarray(0, size)));
            this.size += size;
        }
        this.omitted += data.length - size;
    }

    append(chunk) {
        let data = Buffer.concat([this.pending, chunk]);
        if (!this.started) {
            const marker = data.indexOf(this.start);
            const newline = marker < 0 ? -1 : data.indexOf(10, marker + this.start.length);
            if (newline < 0) {
                this.pending = Buffer.from(data.subarray(-this.start.length - 1));
                return undefined;
            }
            this.started = true;
            data = data.subarray(newline + 1);
        }

        const end = data.indexOf(this.end);
        if (end < 0) {
            const next = Math.max(0, data.length - this.end.length + 1);
            this.capture(data.subarray(0, next));
            this.pending = Buffer.from(data.subarray(next));
            return undefined;
        }

        this.capture(data.subarray(0, end));
        const code = data.subarray(end + this.end.length);
        const newline = code.indexOf(10);
        if (newline < 0 && code.length <= 4) {
            this.pending = Buffer.from(data.subarray(end));
            return undefined;
        }
        this.pending = Buffer.alloc(0);
        const value = code.subarray(0, newline).toString('ascii');
        return newline >= 0 && /^\d{1,3}\r?$/.test(value) && Number(value) <= 255 ? Number(value) : null;
    }

    result(status, exitCode = null, missedBytes = 0) {
        // Keep partial output while excluding any incomplete end marker.
        const marker = this.pending.lastIndexOf(0x1e);
        if (this.started) {
            const suffix = this.pending.subarray(marker);
            const prefix = suffix.subarray(0, this.end.length);
            this.capture(marker >= 0 && this.end.subarray(0, prefix.length).equals(prefix)
                ? this.pending.subarray(0, marker) : this.pending);
        }
        return {
            status,
            exitCode,
            output: Buffer.concat(this.chunks, this.size).toString('utf8'),
            omittedBytes: this.omitted,
            missedBytes,
        };
    }
}

async function runCommand(requestSerial, port, command, timeout, limit) {
    const position = await requestSerial('position', port);
    if (!position) {
        return undefined;
    }
    const marker = randomUUID().replace(/-/g, '');
    const quoted = "'" + command.replace(/'/g, "'\\''") + "'";
    const line = Buffer.from("(printf '\\036%s\\n' '" + marker + "S'; "
        + "sh -c " + quoted + " && code=0 || code=$?; "
        + "printf '\\036%s:%d\\n' '" + marker + "E' \"$code\")\r");
    if (line.length > 4096) {
        return { error: 'Command exceeds the 4096-byte serial input limit after quoting.' };
    }
    if (!await requestSerial('input', port, line.toString('base64'), position.session)) {
        return undefined;
    }

    const output = new CommandOutput(marker, limit);
    const controller = new AbortController();
    const timedOut = Symbol('timeout');
    const deadline = delay(timeout * 1000, timedOut, { signal: controller.signal }).catch(() => timedOut);
    let cursor = position.cursor;
    try {
        while (true) {
            const read = requestSerial('read', port, cursor, position.session);
            const result = await Promise.race([read, deadline]);
            if (result === timedOut) {
                return output.result('timeout');
            }
            if (!result) {
                return output.result('disconnected');
            }
            if (result.missed) {
                return output.result('output_lost', null, result.missed);
            }
            cursor = result.cursor;
            const code = output.append(Buffer.from(result.data, 'base64'));
            if (code !== undefined) {
                return output.result(code === null ? 'invalid_exit_code' : 'completed', code);
            }
            if (await Promise.race([delay(100), deadline]) === timedOut) {
                return output.result('timeout');
            }
        }
    } catch {
        return output.result('disconnected');
    } finally {
        controller.abort();
    }
}

module.exports = { runCommand };
