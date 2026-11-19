const { copyFile, mkdir, lstat, readFile, chmod, mkdtemp, rename, link, rm } = require('node:fs/promises');
const { homedir } = require('node:os');
const { delimiter, join } = require('node:path');

const bin = join(homedir(), '.local', 'bin');
const destination = join(bin, 'serial-sharectl');
const marker = '# Managed by Serial Terminal Share.';

function configureSerialctlPath(context) {
    if (!process.env.PATH?.split(delimiter).includes(bin)) {
        context.environmentVariableCollection.prepend('PATH', bin + delimiter);
    }
}

async function isManagedSerialctl() {
    try {
        return (await lstat(destination)).isFile()
            && (await readFile(destination, 'utf8')).split('\n', 2)[1] === marker;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function installSerialctl(context) {
    await mkdir(bin, { recursive: true });
    const source = context.asAbsolutePath('serial-sharectl');
    const staging = await mkdtemp(join(bin, '.serial-sharectl-'));
    const staged = join(staging, 'serial-sharectl');
    try {
        await copyFile(source, staged);
        await chmod(staged, 0o755);
        if (await isManagedSerialctl()) {
            await rename(staged, destination);
        } else {
            try {
                await link(staged, destination);
            } catch (error) {
                if (error.code === 'EEXIST') {
                    throw new Error(`A different file already exists at ${destination}.`);
                }
                throw error;
            }
        }
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    configureSerialctlPath(context);
    return destination;
}

module.exports = { installSerialctl, isManagedSerialctl, configureSerialctlPath };
