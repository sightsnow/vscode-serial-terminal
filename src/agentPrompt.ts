import * as vscode from 'vscode';

export const socketPrompt = 'VS Code 串口共享支持发现、打开、读写和关闭串口。通过 `SERIAL_TERMINAL_SHARE_SOCKET` 连接，`GET /ports` 查看串口及打开状态，`GET /` 查看其他接口。变量缺失或连接失败时，查询 `/tmp/serialterminal-share/<uid>-*/serial.sock` 的 `GET /`，仅按 `workspaceFolders` 选取唯一匹配当前项目的窗口。读取日志时限量或续读。';
export const serialctlPrompt = 'VS Code 串口共享支持发现、打开、读写和关闭串口。优先用 `serial-sharectl`，找不到命令时用 `~/.local/bin/serial-sharectl`。用 `ports` 查看串口及打开状态，其他操作见 `--help`。读取日志时限量或续读。';

async function updateAgentsFile(prompt: string) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        void vscode.window.showInformationMessage('Open a workspace folder to write AGENTS.md.');
        return;
    }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    if (!folder) {
        return;
    }

    const uri = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');
    try {
        await vscode.workspace.fs.stat(uri);
    } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
            throw error;
        }
        const create = new vscode.WorkspaceEdit();
        create.createFile(uri, { ignoreIfExists: true });
        if (!await vscode.workspace.applyEdit(create)) {
            throw new Error('Could not create AGENTS.md.');
        }
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    if (text.split(/\r?\n/).some(line => line.trim() === prompt)) {
        void vscode.window.showInformationMessage('AGENTS.md already contains the serial prompt.');
        return;
    }

    const wasDirty = document.isDirty;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const separator = !text || text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
    const edit = new vscode.WorkspaceEdit();
    const legacy = prompt === socketPrompt
        ? /^(?:[^\S\r\n]*)调试串口时，优先使用 `?SERIAL_TERMINAL_SHARE_SOCKET`?，请求 `?GET \/`? 查看接口。[^\S\r\n]*$/m.exec(text) ?? /^串口优先用 .*读取缓冲区用 `tail`、`limit` 或 `after`。$/m.exec(text) ?? /^通过 VS Code 共享的串口可发现、打开、读写和关闭。.*日志限量或续读。$/m.exec(text)
        : /^用 `~\/\.local\/bin\/serialctl ports` 查看 VS Code 共享的串口及打开状态，用 `~\/\.local\/bin\/serialctl buffer --tail 40` 限量读取日志，其他操作见 `~\/\.local\/bin\/serialctl --help`。命令缺失时，在 Remote SSH 窗口运行「Serial Terminal Share: Install serialctl」。$/m.exec(text);
    if (legacy) {
        edit.replace(uri, new vscode.Range(document.positionAt(legacy.index),
            document.positionAt(legacy.index + legacy[0].length)), prompt);
    } else {
        edit.insert(uri, document.positionAt(text.length), separator + prompt + eol);
    }
    if (!await vscode.workspace.applyEdit(edit)) {
        throw new Error('Could not append the serial prompt to AGENTS.md.');
    }
    if (wasDirty || !await document.save()) {
        await vscode.window.showTextDocument(document);
        void vscode.window.showInformationMessage('Serial prompt added. Save AGENTS.md to write it to disk.');
        return;
    }
    void vscode.window.showInformationMessage('Serial prompt saved to AGENTS.md.');
}

export async function showAgentPrompt(prompt: string) {
    try {
        const choice = await vscode.window.showQuickPick(['Show prompt', 'Write to AGENTS.md']);
        if (choice === 'Show prompt') {
            if (await vscode.window.showInformationMessage(prompt, 'Copy')) {
                await vscode.env.clipboard.writeText(prompt);
            }
        } else if (choice === 'Write to AGENTS.md') {
            await updateAgentsFile(prompt);
        }
    } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
}
