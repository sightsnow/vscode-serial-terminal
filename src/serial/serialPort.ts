import { log } from "../logger";
import { SerialPort as NativeSerialPort } from "serialport";

interface Configuration {
    baudrate: number,
    parity: 'none' | 'even' | 'odd',
    dataBits: 5 | 6 | 7 | 8,
    stopBits: 1 | 1.5 | 2,

    toString(): string;
    equal(other: Configuration): boolean;
}

class SerialPort {
    private serialPortInstance: NativeSerialPort;
    private portPath: string;
    private cfg: Configuration;
    private openResult: Promise<Error | null>;

    private onOpen: Set<() => void> = new Set;
    private onData: Set<(data: Buffer) => void> = new Set;
    private onClose: Set<() => void> = new Set;

    private constructor(serial: NativeSerialPort, portPah: string, cfg: Configuration, opened: Promise<Error | null>) {
        this.serialPortInstance = serial;
        this.portPath = portPah;
        this.cfg = cfg;
        this.openResult = opened;
        this.init();
    }

    init() {
        this.serialPortInstance.on('open', () => {
            this.onOpen.forEach(callback => callback());
        });

        this.serialPortInstance.on('data', (data) => {
            this.onData.forEach(callback => callback(data));
        });

        this.serialPortInstance.on('close', () => {
            this.onClose.forEach(callback => callback());
        });
    }

    static open(portPath: string, cfg: Configuration, callback?: {
        success: () => void,
        error: (err: Error) => void;
    }): SerialPort {
        const { port, opened } = SerialPort.openSerialPort(portPath, cfg, callback);
        return new SerialPort(port, portPath, cfg, opened);
    }

    private static openSerialPort(portPath: string, cfg: Configuration, callback?: {
        success: () => void,
        error: (err: Error) => void;
    }) {
        let sp: NativeSerialPort;
        let finishOpen!: (error: Error | null) => void;
        const opened = new Promise<Error | null>(resolve => { finishOpen = resolve; });

        let openCallBack = (err: Error | null) => {
            log.info(`Serial port is open(${sp.isOpen}): ${portPath} ${cfg.toString()}`);
            if (sp.isOpen) {
                finishOpen(null);
                callback?.success();
            } else {
                const error = err ?? new Error('Unknown error');
                finishOpen(error);
                callback?.error(error);
            }
        };

        sp = new NativeSerialPort({
            path: portPath,
            baudRate: cfg.baudrate,
            parity: cfg.parity,
            dataBits: cfg.dataBits,
            stopBits: cfg.stopBits,
        }, openCallBack);

        return { port: sp, opened };
    }

    addListener(event: 'open', callback: () => void): this;
    addListener(event: 'data', callback: (data: Buffer) => void): this;
    addListener(event: 'close', callback: () => void): this;
    addListener(event: 'open' | 'data' | 'close', callback: Function): this {
        switch (event) {
            case 'open':
                this.onOpen.add(callback as () => void);
                break;
            case 'data':
                this.onData.add(callback as (data: Buffer) => void);
                break;
            case 'close':
                this.onClose.add(callback as () => void);
                break;
        }
        return this;
    }

    removeListener(event: 'open', callback: () => void): boolean;
    removeListener(event: 'data', callback: (data: Buffer) => void): boolean;
    removeListener(event: 'close', callback: () => void): boolean;
    removeListener(event: 'open' | 'data' | 'close', callback: Function): boolean {
        switch (event) {
            case 'open':
                return this.onOpen.delete(callback as () => void);
            case 'data':
                return this.onData.delete(callback as (data: Buffer) => void);
            case 'close':
                return this.onClose.delete(callback as () => void);
        }
    }

    write(data: string | Buffer): void {
        this.serialPortInstance.write(data);
    }

    async close() {
        await this.openResult;
        const port = this.serialPortInstance;
        if (port.closing) {
            throw new Error('Serial port is still closing. Try again.');
        }
        if (port.isOpen) {
            await new Promise<void>((resolve, reject) => {
                port.close(error => error ? reject(error) : resolve());
            });
        }
    }

    waitForOpen(): Promise<Error | null> {
        return this.openResult;
    }

    reopen(): Promise<Error | null> {
        if (this.serialPortInstance.closing) {
            return Promise.resolve(new Error('Serial port is still closing. Try again.'));
        }
        if (this.isOpen) {
            return Promise.resolve(null);
        }
        if (this.isOpening) {
            return this.openResult;
        }
        this.openResult = new Promise<Error | null>((resolve) => {
            this.serialPortInstance.open((err) => {
                if (err) {
                    log.error(`Failed to reopen serial port ${this.serialPortInstance.path}:`, err);
                } else {
                    log.info(`Serial port ${this.serialPortInstance.path} reopened successfully`);
                }
                resolve(err);
            });
        });
        return this.openResult;
    }

    update(cfg: Configuration): boolean {
        // eslint-disable-next-line eqeqeq
        if (this.cfg.equal(cfg)) {
            log.info(`Serial port configuration is the same, no need to update`);
            return false;
        }

        if (this.cfg.baudrate !== cfg.baudrate && this.cfg.dataBits === cfg.dataBits
            && this.cfg.parity === cfg.parity && this.cfg.stopBits === cfg.stopBits) {
            log.info(`Updating serial port baudrate to ${cfg.baudrate}`);

            this.serialPortInstance.update({ baudRate: cfg.baudrate });
            this.cfg.baudrate = cfg.baudrate;
            return true;
        }
        log.info(`Serial port configuration changed, need to reopen the serial port`);

        this.serialPortInstance.close();
        const { port, opened } = SerialPort.openSerialPort(this.portPath, cfg);
        this.serialPortInstance = port;
        this.openResult = opened;
        this.init();
        this.cfg = cfg;
        return true;
    }

    get name(): string {
        return this.portPath;
    }

    get isOpen(): boolean {
        return this.serialPortInstance.isOpen;
    }

    get isOpening(): boolean {
        return this.serialPortInstance.opening;
    }

    get config(): Configuration {
        return this.cfg;
    }

    // for debug
    fmt = () => `SerialPort(name=${this.portPath}, isOpen=${this.isOpen}, config=${this.cfg.toString()})`;
}

export {
    SerialPort,
    Configuration
};
