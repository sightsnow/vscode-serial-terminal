import { randomUUID } from 'crypto';

const bufferLimit = 256 * 1024;
const inputLimit = 4096;

interface BufferReadOptions {
    tail?: number;
    limit?: number;
}

function tailLines(data: Buffer, count: number): Buffer {
    // A trailing newline terminates the last line.
    let index = data.length - 1;
    if (data[index] === 10) {
        index--;
    }
    for (; index >= 0; index--) {
        if (data[index] === 10 && --count === 0) {
            return data.subarray(index + 1);
        }
    }
    return data;
}

export class SharedSerialPort {
    private readonly buffer = Buffer.alloc(bufferLimit);
    private offset = 0;
    private session = randomUUID();

    constructor(readonly onInput: (data: Buffer) => boolean) { }

    reset() {
        this.offset = 0;
        this.session = randomUUID();
    }

    append(data: Buffer) {
        const tail = data.subarray(Math.max(0, data.length - bufferLimit));
        const start = (this.offset + data.length - tail.length) % bufferLimit;
        const first = Math.min(tail.length, bufferLimit - start);
        tail.copy(this.buffer, start, 0, first);
        tail.copy(this.buffer, 0, first);
        this.offset += data.length;
    }

    position() {
        return { cursor: this.offset, session: this.session };
    }

    write(data: Buffer, session?: string) {
        return (session === undefined || session === this.session) && this.onInput(data);
    }

    read(cursor?: number, session?: string, { tail, limit = bufferLimit }: BufferReadOptions = {}) {
        if ((session !== undefined && session !== this.session) || (cursor ?? 0) > this.offset) {
            return undefined;
        }
        const oldest = Math.max(0, this.offset - bufferLimit);
        const from = cursor === undefined ? Math.max(oldest, this.offset - limit) : Math.max(oldest, cursor);
        const start = from % bufferLimit;
        const length = Math.min(this.offset - from, limit);
        const first = this.buffer.subarray(start, start + length);
        const second = this.buffer.subarray(0, length - first.length);
        const data = Buffer.concat([first, second], length);
        const next = from + length;
        return {
            data: (tail === undefined ? data : tailLines(data, tail)).toString('base64'),
            cursor: next,
            session: this.session,
            missed: Math.max(0, oldest - (cursor ?? oldest)),
            more: next < this.offset,
        };
    }
}

class SerialShare {
    private readonly ports = new Map<string, SharedSerialPort>();

    openPorts() {
        return [...this.ports.keys()];
    }

    register(name: string, port: SharedSerialPort) {
        this.ports.set(name, port);
    }

    unregister(name: string, port: SharedSerialPort) {
        if (this.ports.get(name) === port) {
            this.ports.delete(name);
        }
    }

    request(operation: string, name?: string, value?: string | number, session?: string, options?: BufferReadOptions) {
        if (operation === 'ports') {
            return this.openPorts();
        }
        const port = this.ports.get(name ?? '');
        if (!port) {
            return undefined;
        }
        if (operation === 'position') {
            return port.position();
        }
        const portSession = typeof session === 'string' ? session : undefined;
        if (operation === 'read') {
            const cursor = typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
            return port.read(cursor, portSession, options);
        }
        if (operation === 'input' && typeof value === 'string' && value.length <= Math.ceil(inputLimit / 3) * 4) {
            const data = Buffer.from(value, 'base64');
            return data.length > 0 && data.length <= inputLimit && port.write(data, portSession);
        }
        return undefined;
    }
}

export const serialShare = new SerialShare();
