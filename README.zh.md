# VS Code 串口终端扩展（Serial Terminal）

> 在 VS Code 中直接完成串口连接、收发调试、日志记录与脚本化操作。

[中文](https://github.com/littrick/vscode-serial-terminal/blob/main/README.zh.md)|[English](https://github.com/littrick/vscode-serial-terminal/blob/main/README.md)

---

## ✨ 为什么使用它

- **不切工具**：在编码环境中直接调试串口，减少上下文切换。
- **可追溯**：支持日志保存与查看，便于问题复现和排查。
- **可自动化**：脚本笔记本让重复操作更高效。
- **可定制**：支持配置项与自定义波特率等串口参数。

---

## 🚀 快速开始（3 步）

1. 安装扩展并打开串口侧边栏。
2. 选择串口与参数（如波特率）后连接设备。
3. 在终端中收发数据，按需开启日志记录。

## 从开发机访问串口

在 Windows 安装 Serial Terminal Share 后，通过 VS Code Remote SSH 打开开发机。扩展会安装或更新远端组件。每个窗口使用独立的 `/tmp/serialterminal-share/<uid>-<随机值>/serial.sock`。新开的开发机集成终端通过 `SERIAL_TERMINAL_SHARE_SOCKET` 获取当前窗口的套接字路径。

用 `GET /` 查看窗口的 `workspaceFolders`、接口和示例。环境变量缺失时，从同一 UID 的 socket 中按工作区路径匹配窗口。如果有多个窗口匹配，先确认目标再发串口输入。

在命令面板运行 `Serial Terminal Share: AI Usage Prompt`，可以显示并复制入口提示，也可以创建或追加到工作区的 `AGENTS.md`。

```bash
curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" http://localhost/
curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" http://localhost/ports
curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" -X POST 'http://localhost/open?port=COM4&config=115200n81'
curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" 'http://localhost/buffer?tail=40&limit=4096'
curl -fsS --unix-socket "$SERIAL_TERMINAL_SHARE_SOCKET" -H 'Content-Type: text/plain' \
  --data-binary 'uname -a' 'http://localhost/run?timeout=5&limit=2048'
```

- `GET /ports` 列出 Windows 检测到的串口和打开状态。`POST /open` 在后台打开串口，保留当前编辑器的焦点。需要查看时可从串口侧栏打开对应终端。Windows 只检测到一个串口时可省略 `port`。新建终端默认使用 115200 8N1，已有终端沿用当前配置。
- `POST /close?port=COM4` 关闭由接口打开的终端，等 Windows 释放端口后返回 `204`。手动打开的终端由 VS Code 关闭。只打开一个串口时，读写和关闭请求可以省略 `port`。
- `GET /buffer` 返回串口原始字节。用 `tail` 取末尾行，用 `limit` 限制字节数。把响应头 `X-Serial-Cursor` 的值传给 `after` 可续读。续读时可用 `limit` 分页，`X-Serial-More: 1` 表示还有数据。 `X-Serial-Missed-Bytes` 表示被环形缓冲区覆盖的未读字节数。串口重开后先获取新游标。
- `POST /run` 接收 UTF-8 单行命令，通过设备上已登录的 POSIX shell 执行。响应包含状态、退出码、文本输出和省略的字节数。默认等待 10 秒并返回最多 4096 字节的输出。超时后，设备上的命令可能继续运行。
- `POST /input?enter=1` 发送 `application/octet-stream` 类型的原始输入，并追加回车。适用于 U-Boot、登录提示和交互菜单。 `GET /stream` 持续返回串口输出。

---

## 🎬 功能演示

### 1) 打开串口
![open.gif](https://s2.loli.net/2023/12/24/cF2y9Rpo8ixEQVG.gif)

### 2) 新增串口配置
![config.gif](https://s2.loli.net/2023/12/24/UR6txaOokhm3nYf.gif)

### 3) 开始保存日志
![log.gif](https://s2.loli.net/2023/12/24/NA1ldMSxO4qF5m6.gif)

### 4) 使用脚本笔记本
![script.gif](https://s2.loli.net/2023/12/24/gsVy3Up4jfPxKE2.gif)

---

## 🧩 核心特性

- [x] 终端式实时交互，串口收发响应更直观
- [x] 支持通信日志保存与查看，便于复现与排查
- [x] 支持自动插入时间戳（可在设置中开启）
- [x] 支持自定义串口参数（含波特率）
- [x] 提供脚本笔记本，提升重复调试效率
- [x] 自动处理换行符，无需为 CR/LF 烦恼

---

## ❓ FAQ

### Q: 接收到的数据乱码或者不显示怎么办？

A: 可能是串口参数设置不正确，尤其是波特率。请确认设备的串口参数（如波特率、数据位、停止位、校验位）与扩展设置一致。

### Q: 日志文件在哪里？

A: 你可以从串口侧边栏的日志列表中查看已保存的日志文件，点击文件夹图标可以打开日志所在的文件夹，在设置界面可以自定义日志保存路径。

### Q: Notebook是什么？

A: Notebook（笔记本）是一种交互式文档，可以包含代码单元和文本单元。在串口扩展中，你可以使用Notebook来编写和执行串口交互脚本，自动化常见的调试任务。

---

## 🤝 反馈与贡献

如果你有新的意见，欢迎提交 [Issue](https://github.com/littrick/vscode-serial-terminal/issues) 与 [PR](https://github.com/littrick/vscode-serial-terminal/pulls)，一起把它打磨成更好用的 VS Code 串口工具。
