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

Easy Infer Station 的推理引擎由 Python 驱动，需要提前准备好 Python 环境。

### 第一步：安装 Anaconda 或 Miniconda

如果尚未安装，请从 [Miniconda 官网](https://docs.conda.io/en/latest/miniconda.html) 下载安装（推荐 Miniconda，体积更小）。

### 第二步：创建专用环境

打开终端（Windows 使用 Anaconda Prompt），执行：

```bash
conda create -n yolo-infer python=3.10 -y
conda activate yolo-infer
```

### 第三步：安装依赖包

根据是否有 NVIDIA 显卡选择对应命令：

**无 GPU / 不确定（CPU 推理）**

```bash
pip install flask flask-socketio flask-cors werkzeug simple-websocket \
    gevent gevent-websocket ultralytics pillow pyyaml \
    python-dotenv opencv-python numpy torch torchvision
```

**有 NVIDIA 显卡（GPU 加速推理）**

访问 [pytorch.org](https://pytorch.org/get-started/locally/) 选择对应 CUDA 版本，或直接使用 CUDA 12.x：

```bash
pip install flask flask-socketio flask-cors werkzeug simple-websocket \
    gevent gevent-websocket ultralytics pillow pyyaml \
    python-dotenv opencv-python numpy
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

> 如果已有包含 PyTorch + Ultralytics 的 conda 环境，可跳过此步骤，首次启动时直接选择该环境即可。

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

