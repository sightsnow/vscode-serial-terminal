import * as vscode from 'vscode';
import { readFile } from 'fs/promises';
import { registerCommands } from './commands';
import { registerContextCallback } from './context/context';
import { registerSerialPortView } from './view/serialPortView';
import { registerLogView } from './view/logView';
import { registerScriptView } from './view/scriptView';
import { registerSetting } from './context/setting';
import { registerSerialPortTerminalProfile } from './terminal/provider';
import { requestRemoteSerial } from './terminal/remoteSerial';

const companionId = 'sightsnow.serialterminal-share-remote';

async function installRemoteCompanion(context: vscode.ExtensionContext) {
    if (vscode.env.remoteName !== 'ssh-remote') {
        return;
    }

    const installedVersion: string | undefined = vscode.extensions.getExtension(companionId)?.packageJSON.version;
    const manifest = await readFile(context.asAbsolutePath('companion/package.json'), 'utf8');
    const bundledVersion: string = JSON.parse(manifest).version;
    if (installedVersion && installedVersion.localeCompare(bundledVersion, 'en', { numeric: true }) >= 0) {
        return;
    }
    const packageUri = vscode.Uri.joinPath(context.extensionUri, 'bundled-companion.vsix');
    await vscode.commands.executeCommand('workbench.extensions.installExtension', packageUri);
}

export function activate(context: vscode.ExtensionContext) {
    registerSetting(context);
    registerContextCallback(context);
    registerCommands(context);
    registerSerialPortView(context);
    registerLogView(context);
    registerScriptView(context);
    registerSerialPortTerminalProfile(context);
    context.subscriptions.push(vscode.commands.registerCommand(
        'serialTerminalShare.request', requestRemoteSerial
    ));
    void installRemoteCompanion(context).catch(error => {
        void vscode.window.showWarningMessage(`Serial Terminal Share could not install its Remote SSH component: ${error.message}`);
    });

}

export function deactivate() { }
