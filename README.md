# LumenPnP 本地调试工具

[Opulo LumenPnP](https://opulo.io/)（开源贴片机，国内常称"青蛙"）的本地离线调试工具，全中文界面。**零依赖**——无需安装 Python、Node 或任何软件，Windows 10/11 双击即用。

## 内容

| 目录 | 说明 |
|------|------|
| [opulo-debug-local](opulo-debug-local) | **硬件调试台 v2.0.0**（自研单页，11 个面板）+ 官方 debug.opulo.io 离线镜像（`legacy/`）+ 零依赖启动器 |

## 快速开始

```
cd opulo-debug-local
```

双击 **启动调试工具.bat**，浏览器会自动打开 <http://localhost:8321/>。

- 主页面：<http://localhost:8321/> —— 硬件调试台 v2.0.0
- 官方镜像：<http://localhost:8321/legacy/> —— 官方工具原样离线版 + 中英切换

必须使用 **Chrome 或 Edge**（串口和摄像头依赖 WebSerial / MediaDevices）。不要直接双击 index.html——`file://` 协议下串口与摄像头都不可用。

想先熟悉界面可以选 **演示 · 不连接硬件**，所有面板都能操作，由内置的虚拟控制器和虚拟供料器总线应答，不会发出任何真实指令。

## 能做什么

- **运动**：方向盘式 XY 点动、Z 轴点动、键盘点动（方向键 / WASD + PageUp / PageDown，按住连动）、回零、位置预设一键前往、软件急停（M410 保持连接 + M118 重同步）
- **输出**：上下环形灯（可联动或独立）、左右气泵与阀门，力度 0–255 可调
- **视觉**：上下双 USB 摄像头同时预览、旋转、镜像、十字线、截图
- **供料器**：Photon / RS485 总线 —— 扫描 1–50 号位、编程卡位向导、闪灯定位、单播 / 广播 / 自定义数据包 / 校验和工具
- **自检**：TMC 步进驱动检测（M122）、真空传感器 24 位读数、官方启动序列，报告均可导出
- **终端**：手动 G-code、自定义宏（支持当前坐标与步长占位符）、收发日志

不勾选「允许硬件控制」时任何会动硬件的按钮都点不动；连接时不会自动发送任何指令。

详见 [opulo-debug-local/README.md](opulo-debug-local/README.md)。

## 来源与致谢

- 官方工具：[Opulo](https://opulo.io/) 的 [debug.opulo.io](https://debug.opulo.io/)（属 Opulo 所有），原样保存在 `opulo-debug-local/legacy/`
- Photon 供料器协议的帧格式与校验和算法取自官方工具打包产物，已用 20 万组随机向量交叉验证，逐位一致
- 本仓库做本地化部署、中文界面、能力合并与缺陷修正，供 LumenPnP / 青蛙贴片机用户离线调试使用
