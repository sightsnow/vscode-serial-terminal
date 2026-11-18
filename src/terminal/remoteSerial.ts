import { SerialPortCfg } from '../serial/serialConfiguration';
import { listSerialPort } from '../serial/serialInfo';
import { serialShare } from './serialShare';
import { serialTerminalManager } from './serialTerminal';

async function listDevices() {
    const devices = await listSerialPort();
    const openPorts = new Set(serialShare.openPorts());
    return devices.map(device => ({
        port: device.path,
        manufacturer: device.manufacturer || undefined,
        open: openPorts.has(device.path),
    }));
}

async function openDevice(port?: string, preset?: string | number) {
    const config = typeof preset === 'string' ? SerialPortCfg.parse(preset) : undefined;
    if (typeof preset === 'string' && (!config || !Number.isSafeInteger(config.baudrate)
        || config.baudrate < 1 || config.baudrate > 0xffffffff)) {
        return { status: 400, error: 'Invalid serial configuration. Use a preset such as 115200n81.' };
    }

    const devices = await listDevices();
    const selectOnlyDevice = port === undefined || port === null;
    if (selectOnlyDevice && devices.length > 1) {
        return { status: 409, error: 'Specify a serial port from /ports.' };
    }
    const device = selectOnlyDevice ? devices[0] : devices.find(device => device.port === port);
    if (!device) {
        return { status: 404, error: 'Serial device not found in /ports.' };
    }
    try {
        const opened = await serialTerminalManager.openSharedPort(device.port, config);
        return { status: 200, port: device.port, config: opened.toString() };
    } catch (error) {
        return { status: 409, error: error instanceof Error ? error.message : String(error) };
    }
}

export function requestRemoteSerial(...args: Parameters<typeof serialShare.request>) {
    const [operation, port, preset] = args;
    if (operation === 'devices') {
        return listDevices();
    }
    if (operation === 'open') {
        return openDevice(port, preset);
    }
    if (operation === 'close' && port) {
        return serialTerminalManager.closeSharedPort(port).then(
            () => ({ status: 204 }),
            (error: Error) => ({ status: 409, error: error.message })
        );
    }
    return serialShare.request(...args);
}
