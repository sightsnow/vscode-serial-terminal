import * as vscode from 'vscode';
import { serialTerminalManager } from '../terminal/serialTerminal';

enum ContextKey {
    rcordingLog = "serialTerminalShare.terminal.recordingLog",
    terminalFocus = "serialTerminalShare.terminal.focus"
}

function registerContextCallback(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal(updateSerialTerminalContext));
    updateSerialTerminalContext(vscode.window.activeTerminal);
}

function updateSerialTerminalContext(terminal: vscode.Terminal | undefined) {
    const serial = terminal && serialTerminalManager.getSerialPortTerminalByTerminal(terminal);
    setSerialTerminalFocus(!!serial);
    setSerialTerminalRecordingLog(serial?.isRecordingLog() ?? false);
}

function setSerialTerminalRecordingLog(value: boolean) {
    vscode.commands.executeCommand(
        "setContext",
        ContextKey.rcordingLog,
        value
    );
}

function setSerialTerminalFocus(value: boolean) {
    vscode.commands.executeCommand(
        "setContext",
        ContextKey.terminalFocus,
        value
    );
}

export {
    registerContextCallback,
    updateSerialTerminalContext,
    setSerialTerminalRecordingLog
};
