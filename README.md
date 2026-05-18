# Easy Infer Station

基于 **Tauri 2 + React + Flask** 的桌面端 YOLO 推理工具，支持图片、视频、RTSP 流的实时目标检测与姿态估计。

## 功能特性

- 🚀 **多输入源**：图片、视频文件、RTSP 流
- 🎯 **目标检测**：支持 YOLOv8 / YOLOv11 及自定义 `.pt` 模型
- 🏃 **姿态检测**：支持 YOLO-Pose，含摔倒检测
- 🗂️ **自定义模型**：可通过文件浏览器加载任意本地 `.pt` 模型
- 📊 **实时推流**：WebSocket 实时传输推理帧
- 🔧 **参数调节**：置信度阈值、标签过滤、追踪模式
- 📐 **ROI 区域**：画布交互式绘制感兴趣区域，支持取反报警
- 🚨 **报警图片**：RTSP 模式下自动截图保存报警帧
- 💪 **GPU 加速**：自动检测 CUDA，优先使用 GPU 推理

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面壳 | Tauri 2 (Rust) |
| 前端 | React 19 + TypeScript + Vite 7 + Zustand |
| 后端 | Flask 3 + Flask-SocketIO (port 8080) |
| 推理 | PyTorch + Ultralytics YOLO + OpenCV |
| 图像处理 | OpenCV |

## 项目结构

```
easy_infer_station/
├── app.py                    # Flask 应用入口
├── config.py                 # 配置（HOST/PORT/SECRET_KEY 等）
├── requirements.txt          # Python 依赖
├── .env.example              # 环境变量示例
├── routes/
│   └── main_routes.py        # API 路由 + SocketIO 事件
├── services/
│   └── inference_service.py  # 推理核心逻辑
├── models/                   # 模型文件目录（.pt）
├── uploads/                  # 上传的输入文件
├── results/                  # 推理输出（图片/视频）
├── static/
│   └── alarmimage/           # RTSP 报警截图
├── src/                      # Tauri 前端（React）
│   ├── pages/MainPage.tsx
│   ├── components/
│   └── lib/tauri-bridge.ts   # Tauri API 封装
└── src-tauri/                # Tauri Rust 壳
    └── tauri.conf.json
```

## 环境要求

- **Python**：conda 环境 `yolov8-gpu`（含 PyTorch + CUDA）
- **Node.js**：18+
- **Rust**：最新 stable（Tauri 编译需要）
- **CUDA**：11.8+（可选，无 GPU 自动使用 CPU）

## 安装与启动

### 1. 安装 Python 依赖

```powershell
conda activate yolov8-gpu
pip install -r requirements.txt
```

### 2. 安装前端依赖

```powershell
cd easy_infer_station
npm install
```

### 3. 配置环境变量

```powershell
copy .env.example .env
# 按需修改 .env 中的 HOST / PORT / SECRET_KEY
```

### 4. 开发模式启动

**方式一：分别启动**

```powershell
# 终端 1 - 启动 Python 后端
conda run -n yolov8-gpu python app.py

# 终端 2 - 启动 Tauri 开发窗口
npm run tauri dev
```

**方式二：仅启动后端（在已有浏览器中调试）**

```powershell
conda run -n yolov8-gpu python app.py
# 访问 http://127.0.0.1:8080
```

### 5. 打包发布

```powershell
npm run tauri build
# 输出在 src-tauri/target/release/bundle/
```

## 使用说明

1. 启动后 Tauri 窗口自动打开
2. 从 `models/` 下拉列表选择模型，或点击 📂 按钮加载任意本地 `.pt` 文件
3. 点击"加载标签"读取模型类别
4. 选择输入源类型：**图片 / 视频 / RTSP**
5. 上传文件或填写 RTSP 地址
6. 按需配置推理参数，点击"开始推理"

### 推理参数说明

| 参数 | 说明 |
|------|------|
| 置信度阈值 | 检测结果最低置信度（0.1 ~ 1.0） |
| 标签过滤 | 只显示选中的类别 |
| Pose 模式 | 启用人体关键点检测 |
| 摔倒检测 | Pose 模式下自动判断摔倒 |
| 追踪模式 | 启用 ByteTrack / BoT-SORT 目标追踪 |
| ROI 区域 | 在预览图上框选感兴趣区域 |
| 取反报警 | ROI 内**无目标**时触发报警（适合离岗检测） |
| 报警间隔 | 两次报警之间的最小间隔秒数 |

## 支持的模型

- **检测**：YOLOv8 / YOLOv11 系列及自定义训练模型
- **姿态**：YOLOv8-Pose / YOLOv11-Pose 系列
- 所有 Ultralytics 支持的 `.pt` 格式均可加载

## 常见问题

**Q: 如何使用 GPU？**
安装 PyTorch CUDA 版本后自动使用，启动时控制台会打印 GPU 信息。

**Q: 推理速度慢？**
优先选较小模型（yolov8n / yolo11n），或降低视频分辨率，或减少检测类别。

**Q: RTSP 无法连接？**
检查 URL 格式（`rtsp://user:pass@ip:554/stream`）、网络连通性及摄像头 RTSP 是否开启。

**Q: 自定义模型加载失败？**
确认模型为 Ultralytics YOLO 格式的 `.pt` 文件，且 ultralytics 版本与训练时一致。

