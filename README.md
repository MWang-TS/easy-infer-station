# Easy Infer Station

桌面端 YOLO 目标检测与姿态估计工具，支持图片、视频文件及 RTSP 视频流实时推理。

## 功能特性

- 🚀 **多输入源**：图片、视频文件、RTSP 流
- 🎯 **目标检测**：支持 YOLOv8 系列及自定义 `.pt` 模型
- 🏃 **姿态检测**：支持 YOLO-Pose，含摔倒检测
- 🗂️ **自定义模型**：可通过文件浏览器加载任意本地 `.pt` 模型
- 📊 **实时推流**：WebSocket 实时传输推理帧
- 🔧 **参数调节**：置信度阈值、标签过滤、追踪模式
- 📐 **ROI 区域**：画布交互式绘制感兴趣区域，支持取反报警
- 🚨 **报警图片**：RTSP 模式下自动截图保存报警帧
- 💪 **GPU 加速**：自动检测 CUDA，优先使用 GPU 推理

---

## 下载安装

前往 [Releases](https://github.com/MWang-TS/easy-infer-station/releases) 页面，下载对应平台的安装包：

| 平台 | 安装包 |
|------|--------|
| Windows x64 | `Easy.Infer.Station_*_x64-setup.exe` |
| Windows ARM64 | `Easy.Infer.Station_*_arm64-setup.exe` |
| macOS Apple Silicon | `Easy.Infer.Station_*_aarch64.dmg` |
| macOS Intel | `Easy.Infer.Station_*_x64.dmg` |
| Linux x64 | `easy-infer-station_*_amd64.AppImage` 或 `.deb` |
| Linux ARM64 | `easy-infer-station_*_arm64.AppImage` 或 `.deb` |

下载后直接运行安装包完成安装。

> **macOS 用户**：首次打开若提示"无法验证开发者"，在"系统设置 → 隐私与安全性"中点击"仍然打开"，或在终端运行：
> ```bash
> xattr -rd com.apple.quarantine /Applications/Easy\ Infer\ Station.app
> ```

---

## 前置要求：Python 环境

Easy Infer Station 的推理引擎由 Python 驱动，**首次使用前必须按以下步骤配置好 Python 环境**，之后每次启动无需重复操作。

---

### 第一步：安装 Miniconda

Miniconda 是轻量级的 Python 环境管理工具，用于隔离不同项目的依赖。

| 系统 | 下载地址 |
|------|----------|
| Windows | [Miniconda3-latest-Windows-x86_64.exe](https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe) |
| macOS（Apple Silicon）| [Miniconda3-latest-MacOSX-arm64.sh](https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-arm64.sh) |
| macOS（Intel）| [Miniconda3-latest-MacOSX-x86_64.sh](https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh) |
| Linux x64 | [Miniconda3-latest-Linux-x86_64.sh](https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh) |

**Windows**：下载后双击 `.exe` 安装，安装完成后从开始菜单打开 **Anaconda Prompt**（不要用普通 PowerShell）。

**macOS / Linux**：下载后在终端执行：
```bash
bash Miniconda3-latest-*.sh
```
按提示完成安装，关闭并重新打开终端。

验证安装成功：
```bash
conda --version
# 输出类似：conda 24.x.x
```

---

### 第二步：创建专用 conda 环境

在 **Anaconda Prompt**（Windows）或终端（macOS / Linux）中执行：

```bash
conda create -n yolo-infer python=3.10 -y
```

激活环境：
```bash
conda activate yolo-infer
```

激活成功后，命令行前缀会变为 `(yolo-infer)`。

---

### 第三步：安装依赖包

**先确认当前处于 `(yolo-infer)` 环境中**，然后根据是否有 NVIDIA 显卡选择对应命令：

#### 方案 A：无 GPU（CPU 推理，适合所有设备）

```bash
pip install flask==3.0.0 flask-socketio==5.3.6 flask-cors werkzeug \
    simple-websocket websocket-client \
    gevent gevent-websocket \
    ultralytics==8.2.89 \
    pillow==10.4.0 pyyaml==6.0.1 python-dotenv \
    opencv-python==4.10.0.84 numpy \
    torch torchvision
```

#### 方案 B：有 NVIDIA 显卡（GPU 加速推理，速度更快）

先安装 GPU 版 PyTorch（以 CUDA 12.1 为例，[点此查询你的显卡驱动支持的 CUDA 版本](https://pytorch.org/get-started/locally/)）：

```bash
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

再安装其他依赖：
```bash
pip install flask==3.0.0 flask-socketio==5.3.6 flask-cors werkzeug \
    simple-websocket websocket-client \
    gevent gevent-websocket \
    ultralytics==8.2.89 \
    pillow==10.4.0 pyyaml==6.0.1 python-dotenv \
    opencv-python==4.10.0.84 numpy
```

安装完成后验证：
```bash
python -c "import torch; print('PyTorch:', torch.__version__); print('CUDA 可用:', torch.cuda.is_available())"
python -c "from ultralytics import YOLO; print('ultralytics 已就绪')"
```

> **提示**：如果已有包含 PyTorch + ultralytics 的旧 conda 环境，可直接在首次启动时选择该环境，跳过以上步骤。

---

## 首次启动配置

1. 启动 Easy Infer Station
2. 自动弹出**配置向导**，点击"扫描环境"
3. 在列表中选择上一步创建的 `yolo-infer` 环境（绿色标记表示依赖完整）
4. 点击"确认"完成配置，应用自动启动推理后端

配置保存在本地，**之后启动无需重复设置**。

---

## 使用说明

### 基本流程

1. **选择模型**：从下拉列表选择内置模型，或点击 📂 加载本地 `.pt` 文件
2. **加载标签**：点击"加载标签"读取模型类别名称
3. **选择输入**：选择输入源类型——图片 / 视频 / RTSP
4. **上传或填写**：上传本地文件，或填写 RTSP 流地址
5. **开始推理**：配置好参数后点击"开始推理"

### 推理参数说明

| 参数 | 说明 |
|------|------|
| 置信度阈值 | 过滤低置信度检测结果（建议 0.25～0.5） |
| 标签过滤 | 只显示勾选的目标类别 |
| Pose 模式 | 启用人体关键点检测 |
| 摔倒检测 | Pose 模式下自动判断摔倒事件 |
| 追踪模式 | 启用 ByteTrack 目标持续追踪 |
| ROI 区域 | 在预览图上框选感兴趣区域 |
| 取反报警 | ROI 内**无目标**时触发报警（适合离岗检测） |
| 报警间隔 | 两次报警之间的最短间隔秒数 |

### 模型选择建议

| 场景 | 推荐模型 |
|------|----------|
| 速度优先（边缘设备/CPU） | `yolov8n.pt` |
| 精度与速度均衡 | `yolov8m.pt` |
| 姿态估计 / 摔倒检测 | `yolov8n-pose.pt` |
| 高精度姿态 | `yolov8m-pose.pt` |
| 自定义业务场景 | 自行训练的 `.pt` 文件 |

---

## 常见问题

**Q：配置向导扫描不到任何环境？**  
确认已正确安装 Anaconda 或 Miniconda，且 `conda` 命令可在终端中执行。Windows 用户需使用 Anaconda Prompt 安装或将 conda 加入 PATH。

**Q：环境显示"依赖不完整"（橙色标记）？**  
按照"前置要求"步骤重新在该环境中执行 `pip install` 安装缺失的包。

**Q：如何确认是否在使用 GPU 推理？**  
推理日志中会显示 `device: cuda:0`（GPU）或 `device: cpu`（CPU）。

**Q：推理速度慢？**  
- 优先使用 GPU 版 PyTorch
- 选用较小模型（`yolov8n`）
- 降低视频分辨率或帧率
- 减少需要检测的目标类别

**Q：RTSP 流无法连接？**  
- 确认 URL 格式：`rtsp://用户名:密码@IP地址:554/流路径`
- 检查摄像头是否已开启 RTSP 功能
- 确认应用与摄像头之间网络可达（可先用 VLC 测试）

**Q：自定义模型加载失败？**  
确认模型为 Ultralytics YOLO 格式的 `.pt` 文件，且环境中的 `ultralytics` 版本与训练时一致。

---

## 开源协议

本项目基于 **GNU Affero General Public License v3.0 (AGPL-3.0)** 发布。

本项目使用了以下开源库，在此表示感谢：

| 库 | 协议 | 用途 |
|----|------|------|
| [Ultralytics YOLO](https://github.com/ultralytics/ultralytics) | AGPL-3.0 | 目标检测 / 姿态估计推理引擎 |
| [Tauri](https://github.com/tauri-apps/tauri) | MIT / Apache-2.0 | 桌面应用框架 |
| [React](https://github.com/facebook/react) | MIT | 前端 UI 框架 |
| [Flask](https://github.com/pallets/flask) | BSD-3-Clause | Python 后端 Web 服务 |
| [Flask-SocketIO](https://github.com/miguelgrinberg/Flask-SocketIO) | MIT | WebSocket 实时通信 |
| [OpenCV](https://github.com/opencv/opencv-python) | Apache-2.0 | 图像处理 |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause | 深度学习框架 |

> 由于依赖 Ultralytics（AGPL-3.0），本项目整体须遵循 AGPL-3.0 协议。  
> 如需商业闭源使用，请参考 [Ultralytics 商业授权](https://www.ultralytics.com/license)。

