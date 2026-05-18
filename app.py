"""
# app.py

## 核心功能
主应用入口，负责初始化Flask应用、SocketIO服务和注册API蓝图，是整个应用的启动点。
"""
import os
# 设置环境变量以解决OpenMP库冲突问题
os.environ['KMP_DUPLICATE_LIB_OK'] = 'TRUE'

# 检查GPU是否可用
import torch
CUDA_AVAILABLE = torch.cuda.is_available()
GPU_COUNT = torch.cuda.device_count() if CUDA_AVAILABLE else 0
GPU_NAMES = [torch.cuda.get_device_name(i) for i in range(GPU_COUNT)] if CUDA_AVAILABLE else []

print("="*50)
print("Easy Infer Station - 启动信息")
print("="*50)
print(f"PyTorch版本: {torch.__version__}")
print(f"CUDA是否可用: {CUDA_AVAILABLE}")
if CUDA_AVAILABLE:
    print(f"CUDA版本: {torch.version.cuda}")
    print(f"GPU数量: {GPU_COUNT}")
    for i, name in enumerate(GPU_NAMES):
        print(f"GPU {i}: {name}")
else:
    print("未检测到GPU，将使用CPU进行推理")
print("="*50)

from flask import Flask, send_from_directory
from flask_socketio import SocketIO
from flask_cors import CORS
from config import Config
from routes import main_bp

# 创建Flask应用实例
app = Flask(__name__)

# 启用CORS（允许跨域访问）
CORS(app, resources={r"/*": {"origins": "*"}})

# 配置应用
app.config.from_object(Config)

# 禁用模板缓存（开发模式）
app.config['TEMPLATES_AUTO_RELOAD'] = True
app.jinja_env.auto_reload = True
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

# 初始化必要的文件夹
Config.init_folders()

# 创建SocketIO实例
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# 注册蓝图
app.register_blueprint(main_bp)

# 导入SocketIO事件处理
from routes.main_routes import register_socketio_events
register_socketio_events(socketio)

@app.route('/health')
def health_check():
    """健康检查"""
    return {
        'status': 'ok', 
        'message': 'Easy Infer Station is running',
        'cuda_available': CUDA_AVAILABLE,
        'gpu_count': GPU_COUNT,
        'gpu_names': GPU_NAMES
    }

@app.route('/results/<path:filename>')
def serve_results_file(filename):
    """提供results目录下的文件访问"""
    results_dir = Config.get_results_dir()
    return send_from_directory(results_dir, filename)

@app.route('/uploads/<path:filename>')
def serve_uploads_file(filename):
    """提供uploads目录下的文件访问"""
    uploads_dir = Config.UPLOAD_FOLDER
    return send_from_directory(uploads_dir, filename)

if __name__ == '__main__':
    print("\n启动Easy Infer Station...")
    print(f"访问地址: http://{Config.HOST}:{Config.PORT}")
    print("按 Ctrl+C 停止服务\n")
    
    # 关闭调试模式以防止WebSocket连接断开
    socketio.run(app, host=Config.HOST, port=Config.PORT, debug=False, allow_unsafe_werkzeug=True)
