import { EventEmitter, l10n, Uri, Terminal as VsTerminal, window } from "vscode";
import * as fs from 'fs';
import { Configuration, SerialPort } from "../serial/serialPort";
import { SerialPortCfg } from "../serial/serialConfiguration";
import { Terminal } from "./terminal";
import * as colors from 'colors';
import { setting } from "../context/setting";
import { log } from "../logger";
import * as utils from "../utils";
import * as context from "../context/context";
import { serialShare, SharedSerialPort } from "./serialShare";

class SerialTerminal {
    private serialport: SerialPort;
    private terminal: Terminal;
    private isPty: boolean;
    private readonly share: SharedSerialPort;
    private closed = false;
    private closing?: Promise<void>;
    private onClose: () => void = () => { };

    private constructor(portPath: string, serialport: SerialPort, terminal: Terminal, isPty: boolean) {
        this.isPty = isPty;
        this.share = new SharedSerialPort(data => {
            if (this.closed || this.closing || !serialport.isOpen) {
                return false;
            }
            terminal.write(`\r\n[remote] ${JSON.stringify(data.toString()).replace(/[\x7f-\x9f]/g, char => `\\x${char.charCodeAt(0).toString(16)}`)}\r\n`);
            serialport.write(data);
            return true;
        });

        let cfg = serialport.config;

        serialport.addListener('open', () => {
            this.share.reset();
            if (!this.closed) {
                serialShare.register(portPath, this.share);
            }
            terminal.write(SerialTerminal.connectedFormat(portPath, cfg));
        });
        serialport.addListener('data', (data) => {
            terminal.write(SerialTerminal.terminalFormat(data.toString()));
            this.share.append(data);
        });
        serialport.addListener('close', () => {
            serialShare.unregister(portPath, this.share);
            terminal.write(SerialTerminal.disconnectedFormat(portPath, cfg));
        });

        terminal.addListener('close', () => {
            void this.closeSerial().catch(error => log.error('Failed to close serial port', error));
        });
        terminal.addListener('input', (data) => {
            serialport.write(data);
        });

        this.serialport = serialport;
        this.terminal = terminal;
        if (serialport.isOpen) {
            serialShare.register(portPath, this.share);
        }
    }

    // TODO: 可以考虑作为常量放在外面
    private static serialInfoFormat = (name: string, cfg: Configuration) => `${name} (${cfg.baudrate})`;
    private static terminalName = (name: string, cfg: Configuration) => `${this.serialInfoFormat(name, cfg)}`;
    private static terminalFormat = (text: string) => `${text.replace(/(\r?\n)/g, '\r\n')}`;

    private static connectedFormat = (name: string, cfg: Configuration) =>
        colors.green.bold(l10n.t('{0} CONNECTED', SerialTerminal.serialInfoFormat(name, cfg)) + '\r\n\r\n');
    private static disconnectedFormat = (name: string, cfg: Configuration) =>
        `\r\n${colors.red.bold(l10n.t('{0} DISCONNECTED', SerialTerminal.serialInfoFormat(name, cfg)))}\r\n`;
    private static failedFormat = (name: string, cfg: Configuration, message?: string) =>
        `${colors.red.bold(l10n.t('{0} OPEN FAILED!', SerialTerminal.serialInfoFormat(name, cfg)))}` +
        ` ${message ?? ''}\r\n`;

    private static configChangedFormat = (name: string, cfg: Configuration) =>
        `\r\n${colors.yellow.bold(l10n.t('{0} CONFIG CHANGED!', SerialTerminal.serialInfoFormat(name, cfg)))}\r\n`;

    recording: {
        timestamp: () => boolean,
        timeStampDurationNs: () => number,
        lastTimeStamp: bigint,
    } | undefined;

    static async new(portPath: string, cfg: Configuration, isPty: boolean = false): Promise<SerialTerminal> {
        const terminal = new Terminal(this.terminalName(portPath, cfg), isPty);
        let closed = false;
        terminal.addListener('close', () => { closed = true; });

        // Allow the VS Code terminal to initialize before the device starts sending output.
        await new Promise(resolve => setTimeout(resolve, 200));
        if (closed) {
            throw new Error('The terminal closed before the port could open.');
        }

        try {
            const serialport = SerialPort.open(portPath, cfg, {
                success: () => { },
                error: (err) => {
                    console.error(`Failed to open serial port ${portPath}:`, err);
                    terminal.write(this.failedFormat(portPath, cfg, err.message));
                }
            });

            return new SerialTerminal(portPath, serialport, terminal, isPty);
        } catch (error) {
            terminal.close();
            throw error;
        }
    }

    private logCallback: (data: Buffer) => void = () => { };
    private timeStampFormat = (text: string) => `[${utils.getTimeStamp()}] ${text}`;
    private timeStampHandle = (text: string) => {
        // 计算与上次添加时间戳的时间差，单位为纳秒
        // 如果时间差大于等于设定的时间戳添加间隔，则在文本前添加时间戳
        // this.recording不能为空

        const currentTime = process.hrtime.bigint();
        let diff = currentTime - this.recording!.lastTimeStamp;

        // 更新最后一次计算时间戳的时间
        this.recording!.lastTimeStamp = currentTime;

        if (diff >= BigInt(this.recording!.timeStampDurationNs())) {
            return this.timeStampFormat(text);
        }
        return text;
    };

    private buildCallback(logFile: Uri) {
        fs.writeFileSync(logFile.fsPath, '');

        if (!this.recording) { return; }
        if (this.recording.timestamp()) {
            this.logCallback = (data: Buffer) => {
                const text = this.timeStampHandle(data.toString());
                fs.appendFileSync(logFile.fsPath, text);
            };
        } else {
            this.logCallback = (data: Buffer) => {
                fs.appendFileSync(logFile.fsPath, data.toString());
            };
        }
    }

    beginRecord(logFile: Uri) {
        if (this.isRecordingLog()) {
            log.warn("Already recording log, stop current recording before starting a new one");
            return;
        }

        log.info(`Start recording log to ${logFile.fsPath}`);

        this.recording = {
            timestamp: () => setting.addingTimeStamp,
            timeStampDurationNs: () => setting.timeStampDurationNs,
            lastTimeStamp: process.hrtime.bigint(),
        };
        this.buildCallback(logFile);
        this.serialport.addListener('data', this.logCallback);

        context.setSerialTerminalRecordingLog(true);
    }

    stopRecord() {
        if (!this.isRecordingLog()) {
            log.warn("Not recording log");
            return;
        }

        this.serialport.removeListener('data', this.logCallback);
        this.recording = undefined;
        log.info("Stop recording log");
        context.setSerialTerminalRecordingLog(false);
    }

    serialConfig(): Configuration {
        return this.serialport.config;
    }

    private async checkAndReopen() {
        if (!this.closed && !this.closing && !this.serialport.isOpen && !this.serialport.isOpening) {
            const err = await this.serialport.reopen();
            if (err) {
                log.error(`Failed to reopen serial port ${this.serialport.name}`);
                this.terminal.write(SerialTerminal.failedFormat(this.serialport.name, this.serialConfig(), err.message));
            }
        }
    }

    async updateSerial(cfg?: Configuration) {
        log.info(`Updating serial port ${this.serialport.name} config with ${cfg ? cfg.toString() : 'current config'}`);
        if (this.closed || this.closing) {
            throw new Error('The serial terminal is closing.');
        }
        this.checkAndReopen();

        if (cfg && this.serialport.update(cfg)) {
            log.info(`Serial port ${this.serialport.name} configuration updated`);
            this.terminal.write(SerialTerminal.configChangedFormat(this.serialport.name, cfg));
            // TODO： 目前串口配置改变后，终端名称不会改变，可以考虑在配置改变后更新终端名称
        }
    }

    async show() {
        // 如果串口没有打开，先尝试打开串口
        log.info(`Showing serial terminal for port ${this.serialport.name}`);
        this.checkAndReopen();
        if (!this.isPty) {
            this.terminal.show();
        }
    }

    async ensureSharedOpen(reopen: boolean) {
        if (this.closed || this.closing) {
            throw new Error('The serial terminal is closing.');
        }
        const error = await (reopen ? this.serialport.reopen() : this.serialport.waitForOpen());
        if (error) {
            throw error;
        }
        if (this.closed || this.closing || !this.serialport.isOpen) {
            throw new Error('The serial port closed while opening.');
        }
    }

    close() {
        return this.closeSerial(true);
    }

    private closeSerial(closeTerminal = false): Promise<void> {
        if (this.closed) {
            return Promise.resolve();
        }
        this.closing ??= this.serialport.close().then(() => {
            this.closed = true;
            serialShare.unregister(this.portName(), this.share);
            this.onClose();
            if (closeTerminal) {
                this.terminal.close();
            }
        }).finally(() => { this.closing = undefined; });
        return this.closing;
    }

    getTerminalOptions() {
        return this.terminal.options;
    }

    portName() {
        return this.serialport.name;
    }

    isRecordingLog() {
        return !!this.recording;
    }

    setOnCloseCallback(callback: () => void) {
        this.onClose = callback;
    }

    // for debug
    fmt = () => `SerialTerminal(port=${this.serialport.fmt()}, terminal=${this.terminal.fmt()}, isRecording=${this.isRecordingLog()})`;
}

class SerialTerminalManager {
    private terminals: Map<string, SerialTerminal> = new Map();
    private readonly creating = new Map<string, Promise<SerialTerminal>>();
    private readonly openedRemotely = new WeakSet<SerialTerminal>();

    async getOrCreateSerialPortTerminal(portPath: string, cfg: Configuration, isPty: boolean = false): Promise<SerialTerminal> {
        let exist = this.terminals.get(portPath);
        if (exist) {
            log.info(`Serial terminal for port ${portPath} already exists, updating config and showing it`);

            await exist.updateSerial(cfg);
            await exist.show();
            return exist;
        }
        return this.createTerminal(portPath, cfg, isPty);
    }

    private createTerminal(portPath: string, cfg: Configuration, isPty = false, remote = false) {
        const pending = this.creating.get(portPath);
        if (pending) {
            return pending;
        }
        const creation = SerialTerminal.new(portPath, cfg, isPty).then(terminal => {
            if (remote) {
                this.openedRemotely.add(terminal);
            }
            terminal.setOnCloseCallback(() => {
                log.info(`Serial terminal for port ${portPath} closed, removing from manager`);
                this.terminals.delete(portPath);
            });
            this.terminals.set(portPath, terminal);
            context.updateSerialTerminalContext(window.activeTerminal);
            return terminal;
        }).finally(() => this.creating.delete(portPath));
        this.creating.set(portPath, creation);
        return creation;
    }

    async openSharedPort(portPath: string, cfg?: Configuration) {
        const existing = this.terminals.get(portPath);
        const pending = this.creating.get(portPath);
        const terminal = existing ?? await (pending ?? this.createTerminal(
            portPath, cfg ?? new SerialPortCfg(115200, 'none', 8, 1), false, true
        ));
        if (cfg && !cfg.equal(terminal.serialConfig())) {
            throw new Error(`The existing terminal uses ${terminal.serialConfig()}. Close it before changing its configuration.`);
        }
        try {
            await terminal.ensureSharedOpen(!!existing);
            return terminal.serialConfig();
        } catch (error) {
            if (!existing && !pending) {
                await terminal.close();
            }
            throw error;
        }
    }

    async closeSharedPort(portPath: string) {
        const terminal = this.terminals.get(portPath) ?? await this.creating.get(portPath);
        if (!terminal) {
            return;
        }
        if (!this.openedRemotely.has(terminal)) {
            throw new Error('Close this manually opened serial terminal in VS Code.');
        }
        await terminal.close();
    }

    getSerialPortTerminal(portPath: string): SerialTerminal | undefined {
        return this.terminals.get(portPath);
    }

    getSerialPortTerminalByTerminal(terminal: VsTerminal): SerialTerminal | undefined {
        const options = terminal.creationOptions;
        if (!('pty' in options)) {
            return undefined;
        }
        for (let serialTerminal of this.terminals.values()) {
            if (serialTerminal.getTerminalOptions().pty === options.pty) {
                return serialTerminal;
            }
        }
        return undefined;
    }

    // for debug
    printfSerialPortTerminals() {
        log.info("Current serial port terminals:");
        for (let [portPath, serialTerminal] of this.terminals.entries()) {
            log.info(`- ${portPath}: ${serialTerminal.fmt()}`);
        }
    }
}


const serialTerminalManager = new SerialTerminalManager();

export {
    SerialTerminal,
    serialTerminalManager,
};
