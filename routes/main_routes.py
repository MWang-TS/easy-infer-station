"""
# routes/main_routes.py

## 核心功能
主要路由和SocketIO事件处理
"""
import os
import hmac
from flask import render_template, request, jsonify
from werkzeug.utils import secure_filename
from . import main_bp
from config import Config
from services.inference_service import InferenceService
import torch

# 全局推理服务实例
inference_service = None


def _extract_bearer_token(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    parts = value.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == 'bearer':
        return parts[1].strip() or None
    return None


def _get_request_token() -> str | None:
    token = request.headers.get('X-API-Token')
    if token:
        token = token.strip()
        return token or None

    auth = request.headers.get('Authorization')
    token = _extract_bearer_token(auth)
    if token:
        return token

    token = request.args.get('api_token')
    if token:
        token = token.strip()
        return token or None

    return None


def _is_token_valid(token: str | None) -> bool:
    if not Config.API_TOKEN:
        return True
    if not token:
        return False
    return hmac.compare_digest(token, Config.API_TOKEN)


@main_bp.before_request
def _enforce_api_token_for_api_routes():
    # 可选鉴权：仅保护 /api/*
    if not Config.API_TOKEN:
        return None
    if request.method == 'OPTIONS':
        return None
    if not request.path.startswith('/api/'):
        return None

    token = _get_request_token()
    if _is_token_valid(token):
        return None

    return jsonify({
        'success': False,
        'message': 'Unauthorized: missing or invalid API token'
    }), 401

@main_bp.route('/')
def index():
    """首页"""
    return render_template('index.html')

@main_bp.route('/test')
def test():
    """测试页面"""
    return render_template('test.html')

@main_bp.route('/api/upload/model', methods=['POST'])
def upload_model():
    """上传模型文件"""
    if 'file' not in request.files:
        return jsonify({'success': False, 'message': '没有文件上传'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'success': False, 'message': '未选择文件'}), 400
    
    # 先从原始文件名提取扩展名
    original_filename = file.filename
    ext = original_filename.rsplit('.', 1)[1].lower() if '.' in original_filename else ''
    
    if ext == 'pt':
        # 使用原始文件名（如果没有中文）或生成时间戳文件名
        try:
            filename = secure_filename(original_filename)
            if not filename or not filename.endswith('.pt'):
                # 如果secure_filename处理后文件名不合法，使用时间戳
                import time
                timestamp = int(time.time() * 1000)
                filename = f"model_{timestamp}.pt"
        except:
            import time
            timestamp = int(time.time() * 1000)
            filename = f"model_{timestamp}.pt"
        
        filepath = os.path.join(Config.get_models_dir(), filename)
        file.save(filepath)
        
        return jsonify({
            'success': True,
            'message': '模型上传成功',
            'filepath': filepath,
            'filename': filename
        })
    
    return jsonify({'success': False, 'message': '不支持的文件格式'}), 400

@main_bp.route('/api/upload/input', methods=['POST'])
def upload_input():
    """上传输入文件（图片或视频）"""
    try:
        if 'file' not in request.files:
            return jsonify({'success': False, 'message': '没有文件上传'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'success': False, 'message': '未选择文件'}), 400
        
        # 先从原始文件名提取扩展名
        original_filename = file.filename
        ext = original_filename.rsplit('.', 1)[1].lower() if '.' in original_filename else ''
        
        # 生成安全的文件名（使用时间戳）
        import time
        timestamp = int(time.time() * 1000)
        filename = f"{timestamp}.{ext}"
        
        print(f"上传文件: {original_filename}, 扩展名: {ext}, 保存为: {filename}")
        
        if ext in Config.ALLOWED_IMAGE_EXTENSIONS or ext in Config.ALLOWED_VIDEO_EXTENSIONS:
            # 确保上传目录存在
            os.makedirs(Config.UPLOAD_FOLDER, exist_ok=True)
            
            filepath = os.path.join(Config.UPLOAD_FOLDER, filename)
            print(f"保存文件到: {filepath}")
            
            file.save(filepath)
            
            input_type = 'image' if ext in Config.ALLOWED_IMAGE_EXTENSIONS else 'video'
            
            print(f"文件上传成功: {filepath}, 类型: {input_type}")
            
            return jsonify({
                'success': True,
                'message': f'{"图片" if input_type == "image" else "视频"}上传成功',
                'filepath': filepath,
                'filename': filename,
                'input_type': input_type
            })
        
        return jsonify({'success': False, 'message': f'不支持的文件格式: {ext}'}), 400
    except Exception as e:
        print(f"上传文件错误: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': f'上传失败: {str(e)}'}), 500

@main_bp.route('/api/models/list', methods=['GET'])
def list_models():
    """列出可用的模型"""
    models_dir = Config.get_models_dir()
    models = []
    
    try:
        # 列出models目录下的所有.pt文件
        if os.path.exists(models_dir):
            for filename in os.listdir(models_dir):
                if filename.endswith('.pt'):
                    filepath = os.path.join(models_dir, filename)
                    # 转换为正斜杠，避免JSON转义问题
                    filepath = filepath.replace('\\', '/')
                    filesize = os.path.getsize(os.path.join(models_dir, filename))
                    models.append({
                        'filename': filename,
                        'filepath': filepath,
                        'size': f"{filesize / (1024*1024):.2f} MB"
                    })
    except Exception as e:
        print(f"列出模型文件错误: {str(e)}")
        import traceback
        traceback.print_exc()
    
    return jsonify({'success': True, 'models': models})

@main_bp.route('/api/model/labels', methods=['GET', 'POST'])
def get_model_labels():
    """获取模型的标签并预加载模型"""
    if request.method == 'GET':
        model_path = request.args.get('model_path', '')
    else:
        data = request.json or {}
        model_path = data.get('model_path', '')
    
    if not model_path or not os.path.exists(model_path):
        return jsonify({'success': False, 'message': '模型文件不存在'}), 400
    
    try:
        from ultralytics import YOLO
        
        # 加载模型获取标签
        model = YOLO(model_path)
        labels = model.names
        
        # 预加载模型到InferenceService（避免推理时加载延迟）
        print(f"预加载模型到InferenceService: {model_path}")
        inference_service.load_model(model_path)
        print("模型预加载完成")
        
        return jsonify({
            'success': True,
            'labels': labels,
            'count': len(labels),
            'model_preloaded': True  # 标识模型已预加载
        })
    except Exception as e:
        return jsonify({'success': False, 'message': f'加载模型标签失败: {str(e)}'}), 500

@main_bp.route('/api/system/info', methods=['GET'])
def get_system_info():
    """获取系统信息"""
    cuda_available = torch.cuda.is_available()
    info = {
        'cuda_available': cuda_available,
        'pytorch_version': torch.__version__,
    }
    
    if cuda_available:
        info['cuda_version'] = torch.version.cuda
        info['gpu_count'] = torch.cuda.device_count()
        info['gpu_names'] = [torch.cuda.get_device_name(i) for i in range(info['gpu_count'])]
    
    return jsonify({'success': True, 'info': info})

@main_bp.route('/api/preview/first_frame', methods=['GET'])
def get_first_frame():
    """读取视频文件或RTSP流的第一帧，返回base64图像，供ROI绘制预览使用"""
    import cv2
    import base64

    source = request.args.get('source', '')
    source_type = request.args.get('type', 'video')

    if not source:
        return jsonify({'success': False, 'message': '未提供source参数'}), 400

    try:
        cap = cv2.VideoCapture(source)
        if source_type == 'rtsp':
            cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 8000)
            cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000)

        ret, frame = cap.read()
        cap.release()

        if not ret or frame is None:
            return jsonify({'success': False, 'message': '无法读取帧，请确认路径或流地址是否正确'}), 400

        _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        frame_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode('utf-8')
        return jsonify({'success': True, 'frame': frame_b64})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500

@main_bp.route('/api/shutdown', methods=['POST'])
def shutdown():
    """优雅关机（Tauri 在关闭窗口时调用）"""
    import threading
    import os
    import signal
    def _stop():
        import time
        time.sleep(0.3)
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=_stop, daemon=True).start()
    return jsonify({'success': True, 'message': '服务正在关闭'})


@main_bp.route('/api/alarm/clear', methods=['POST'])
def clear_alarm_images():
    """清空报警图片"""
    try:
        import shutil
        alarm_dir = os.path.join('static', 'alarmimage')
        
        # 如果目录存在，删除所有文件
        if os.path.exists(alarm_dir):
            # 删除目录中的所有文件
            for filename in os.listdir(alarm_dir):
                file_path = os.path.join(alarm_dir, filename)
                try:
                    if os.path.isfile(file_path):
                        os.unlink(file_path)
                except Exception as e:
                    print(f"删除文件 {filename} 失败: {str(e)}")
            
            return jsonify({
                'success': True,
                'message': '报警图片已清空'
            })
        else:
            return jsonify({
                'success': True,
                'message': '报警图片目录不存在'
            })
    except Exception as e:
        return jsonify({
            'success': False,
            'message': f'清空失败: {str(e)}'
        }), 500

def register_socketio_events(socketio):
    """注册SocketIO事件"""
    global inference_service
    inference_service = InferenceService(socketio)
    
    @socketio.on('connect')
    def handle_connect(auth):
        # 可选鉴权：当 Config.API_TOKEN 设置时，未携带/错误 token 的连接直接拒绝
        token = None
        if isinstance(auth, dict):
            token = auth.get('token')
        if not token:
            # 兼容 query string: ?token=...
            token = request.args.get('token')

        if not _is_token_valid(token):
            raise ConnectionRefusedError('unauthorized')

        print('客户端已连接')
        socketio.emit('message', {'type': 'info', 'message': '已连接到服务器'})
    
    @socketio.on('disconnect')
    def handle_disconnect():
        print('客户端已断开')
    
    @socketio.on('start_inference')
    def handle_start_inference(data):
        """开始推理"""
        try:
            print(f"收到推理请求: input_type={data.get('input_type')}")
            inference_service.start_inference(data)
        except Exception as e:
            print(f"推理启动失败: {str(e)}")
            import traceback
            traceback.print_exc()
            socketio.emit('inference_error', {'message': str(e)})
    
    @socketio.on('stop_inference')
    def handle_stop_inference():
        """停止推理"""
        try:
            print("收到停止推理请求")
            inference_service.stop_inference()
        except Exception as e:
            print(f"停止推理失败: {str(e)}")
            socketio.emit('inference_error', {'message': str(e)})
