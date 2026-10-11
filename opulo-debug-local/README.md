# LumenPnP 调试工具 - 本地离线版

[Opulo LumenPnP 贴片机官方调试工具](https://debug.opulo.io/) 的本地离线镜像，并做了中文增强。**零依赖**——无需安装 Python、Node 或任何软件，Windows 10/11 双击即用。

## 功能

- **完整离线镜像**：与线上版功能 100% 一致（Control 控制、Feeder 供料器编程、TMC 驱动测试、真空传感器测试、G 代码 REPL）
- **中英文切换**：右下角「中 / EN」按钮一键切换，自动记忆偏好（localStorage）
- **弹窗汉化**：所有提示弹窗（连接失败、编程结果、固件版本等）自动翻译
- **零依赖启动**：用 Windows 自带 PowerShell 实现本地静态服务器（`server.ps1`）

## 使用方法

1. 双击 **启动调试工具.bat**
2. 浏览器自动打开 <http://localhost:8321/>
3. 用 USB 线连接贴片机主板并上电
4. 点左上角 **连接 / Connect**，在浏览器弹窗中选择对应 COM 口
5. 即可使用回原点、点动、真空测试、供料器扫描编程等功能

> 必须使用 **Chrome 或 Edge** 浏览器（串口通信依赖 WebSerial API，Firefox 不支持）。
> 不要直接双击 index.html 打开（file:// 协议下 WebSerial 不可用）。

## 文件结构

```
opulo-debug-local/
├── 启动调试工具.bat    # 一键启动（自动清理端口 → 起服务器 → 开浏览器）
├── server.ps1          # 零依赖静态服务器（PowerShell 实现）
├── index.html          # 页面（含中英切换脚本）
└── assets/             # 原站 JS/CSS/图片（未改动，保证功能一致）
```

## 常见问题

| 问题 | 解决方法 |
|------|---------|
| 提示「无法写入串口」 | 先点「连接」选好 COM 口再操作 |
| 连接弹窗里没有 COM 口 | 检查 USB 线（需数据线）、机器是否上电；老主板装 CH340/CP2102 驱动 |
| 端口被占用 | bat 会自动结束占用进程；也可手动关闭旧的「LumenPnP Server」窗口 |
| 页面空白 | 确认通过 http://localhost:8321/ 访问，按 Ctrl+F5 强制刷新 |
| Marlin 不支持 Photon 协议 | 按[官方教程](https://docs.opulo.io/byop/motherboard/update-firmware/)升级固件 |

## 致谢与来源

- 原工具：[Opulo](https://opulo.io/) 的 [debug.opulo.io](https://debug.opulo.io/)（属 Opulo 所有）
- 本仓库仅做本地化部署与中文界面增强，供 LumenPnP 用户离线调试使用
