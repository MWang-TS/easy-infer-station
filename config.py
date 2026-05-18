"""
# config.py

## 核心功能
应用配置管理中心，负责定义和管理应用的各项配置，包括服务器配置、文件上传配置、推理参数默认值等。
"""
import os
from dotenv import load_dotenv

# 加载环境变量
load_dotenv()

class Config:
    """应用配置类"""
    
    # 服务器配置
    SECRET_KEY = os.environ.get('SECRET_KEY') or 'infer-secret-key'
    DEBUG = os.environ.get('DEBUG', 'True').lower() == 'true'
    PORT = int(os.environ.get('PORT', '8080'))  # 改为8080，常用的Web开发端口
    HOST = os.environ.get('HOST', '127.0.0.1')  # 改为127.0.0.1避免权限问题

    # 可选：API/Socket鉴权（未设置则不启用）
    API_TOKEN = (os.environ.get('API_TOKEN') or '').strip()

    # 可选：CORS白名单（后续可收敛CORS用）
    CORS_ORIGINS = (os.environ.get('CORS_ORIGINS') or '').strip()
    
    # 文件上传配置
    UPLOAD_FOLDER = os.environ.get('UPLOAD_FOLDER') or 'uploads'
    MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500MB（视频文件可能较大）
    ALLOWED_IMAGE_EXTENSIONS = {'jpg', 'jpeg', 'png', 'bmp'}
    ALLOWED_VIDEO_EXTENSIONS = {'mp4', 'avi', 'mov', 'mkv'}
    ALLOWED_MODEL_EXTENSIONS = {'pt'}
    
    # 推理配置
    @classmethod
    def get_app_root(cls):
        """获取应用根目录"""
        return os.path.dirname(os.path.abspath(__file__))
    
    @classmethod
    def get_results_dir(cls):
        """获取推理结果输出目录"""
        return os.path.join(cls.get_app_root(), 'results')
    
    @classmethod
    def get_models_dir(cls):
        """获取模型目录"""
        return os.path.join(cls.get_app_root(), 'models')
    
    # 默认推理参数
    DEFAULT_PARAMS = {
        "model_path": "",
        "confidence": 0.5,
        "iou_threshold": 0.45,
        "input_type": "image",  # image, video, rtsp
        "input_path": "",
        "device": "cuda" if os.environ.get('CUDA_AVAILABLE', 'true').lower() == 'true' else "cpu",
        "tracking_enabled": False,
        "roi_enabled": False,
        "roi_coords": [],
        "alarm_enabled": False,
    }
    
    # Pose模式默认参数
    DEFAULT_POSE_PARAMS = {
        "pose_mode_enabled": False,
        "fall_detection_enabled": False,
        "show_keypoints": True,
        "show_skeleton": True,
        "fall_threshold": 0.7,
    }
    
    @staticmethod
    def init_folders():
        """初始化必要的文件夹"""
        folders = [
            Config.UPLOAD_FOLDER,
            Config.get_results_dir(),
            Config.get_models_dir(),
        ]
        for folder in folders:
            os.makedirs(folder, exist_ok=True)
