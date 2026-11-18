import * as vscode from 'vscode';
import { FileTreeDataProvider } from './FileTreeDataProvider';
import { setting } from '../context/setting';

function registerScriptView(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
            "serialTerminalShare.scriptsNotebooks",
            new FileTreeDataProvider(
                ['.scrnb', '.mdnb', '.md'],
                () => setting.noteBookFolder,
                {
                    command: "serialTerminalShare.treeItem.openOnEditor",
                    readdirErrorMessagePrefix: vscode.l10n.t("Script path error: "),
                    icon: new vscode.ThemeIcon("notebook"),
                }
            )
        )
    );
}

export { registerScriptView };