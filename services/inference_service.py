"""
# services/inference_service.py

## 核心功能
推理服务，负责执行模型推理任务
"""
import os
import cv2
import time
import threading
import torch
import numpy as np
from datetime import datetime
from ultralytics import YOLO
from config import Config
from PIL import Image
import base64
import io

from services import model_registry as registry
from services import model_downloader

class InferenceService:
    """推理服务类"""
    
    def __init__(self, socketio):
        self.socketio = socketio
        self.is_running = False
        self.inference_thread = None
        self.model = None
        self.model_path = None  # 记录当前加载的模型路径
        self.model_device = None
        self.video_capture = None
        self.result_video_writer = None
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

        self.current_input_type = None
        # 当前模型的任务（detect / segment / classify / pose / obb），由模型自身决定
        self.current_task = None
        # 模型信息缓存（家族 / 任务 / 类别数），供接口查询
        self.model_info = {}

    # ─── 任务与模型解析 ──────────────────────────────────────
    def task(self) -> str:
        """当前推理任务。以模型元数据为准，缺失时才退回 detect。"""
        return self.current_task or registry.resolve_task(self.model)

    def _ensure_model_file(self, model_ref: str):
        """把「官方权重名」按需下载到 models/；本地路径原样返回。"""
        def _progress(received, total):
            try:
                self.socketio.emit('model_download_progress', {
                    'name': os.path.basename(str(model_ref)),
                    'received': received,
                    'total': total,
                })
            except Exception:
                pass

        return model_downloader.ensure_local(model_ref, _progress)

    def model_summary(self) -> dict:
        """模型信息（未加载时返回空壳）。"""
        if not self.model or not self.model_path:
            return {}
        try:
            info = registry.describe_model(self.model, self.model_path)
        except Exception:
            return dict(self.model_info or {})
        info['model_path'] = self.model_path
        info['device'] = self.model_device
        self.model_info = info
        return info
    
    def load_model(self, model_path):
        """预加载模型到内存"""
        try:
            local_path = self._ensure_model_file(model_path)
            if not local_path:
                print(f"预加载模型失败: 找不到模型 {model_path}")
                return False

            # 如果已经加载了相同的模型，跳过
            if self.model and self.model_path == local_path:
                print(f"模型已加载: {local_path}")
                return True

            print(f"开始加载模型: {local_path}")
            model = YOLO(local_path)
            device_str = self._device_str(self.device)
            model.to(device_str)
            self.model = model
            self.model_path = local_path
            self.model_device = device_str
            self.current_task = registry.resolve_task(model)
            self.model_info = registry.describe_model(model, local_path)
            print(
                f"模型加载成功，任务: {self.current_task}，"
                f"类别数: {self.model_info.get('class_count')}，设备: {device_str}"
            )
            return True
        except Exception as e:
            print(f"预加载模型失败: {str(e)}")
            self.model = None
            self.model_path = None
            self.model_device = None
            self.current_task = None
            self.model_info = {}
            return False
        
    def start_inference(self, params):
        """启动推理"""
        if self.is_running:
            self.socketio.emit('inference_error', {'message': '推理正在进行中'})
            return

        # 不等待旧线程退出（join 会阻塞 gevent 事件循环）
        # 旧线程会因 is_running=False 自行退出，且 finally 有线程身份校验不会影响新线程

        input_type = params.get('input_type', 'image')
        model_path = params.get('model_path')
        if not model_path:
            self.socketio.emit('inference_error', {'message': '未选择模型'})
            return

        # 支持「官方权重名」：yolo11n.pt / yolo26n-pose.pt 之类，缺失时自动下载
        try:
            local_model = self._ensure_model_file(model_path)
        except Exception as e:
            self.socketio.emit('inference_error', {'message': f'模型下载失败: {e}'})
            return
        if not local_model or not os.path.exists(local_model):
            self.socketio.emit('inference_error', {'message': f'模型文件不存在: {model_path}'})
            return

        if local_model != model_path:
            params = dict(params)
            params['model_path'] = local_model

        input_path = params.get('input_path', params.get('input_source', ''))
        if input_type not in ['rtsp', 'images'] and not os.path.exists(input_path):
            self.socketio.emit('inference_error', {'message': '输入文件不存在'})
            return

        if input_type == 'images':
            raw_paths = params.get('input_paths', [])
            if not isinstance(raw_paths, list):
                self.socketio.emit('inference_error', {'message': '参数错误：input_paths 须为列表'})
                return
            valid_paths = [p for p in raw_paths if isinstance(p, str) and p.strip()]
            if not valid_paths:
                self.socketio.emit('inference_error', {'message': '没有有效的图片路径'})
                return
            params = dict(params)
            params['input_paths'] = valid_paths

        self.current_input_type = input_type
        self.is_running = True
        self.inference_thread = threading.Thread(target=self._run_inference, args=(params,))
        self.inference_thread.daemon = True
        self.inference_thread.start()
        
    def stop_inference(self):
        """停止推理"""
        self.is_running = False
        self.current_input_type = None
        
        # 安全地释放视频捕获对象
        if self.video_capture:
            try:
                self.video_capture.release()
            except:
                pass
            self.video_capture = None
        
        # 安全地释放视频写入器
        if self.result_video_writer:
            try:
                self.result_video_writer.release()
            except:
                pass
            self.result_video_writer = None
        
        self.socketio.emit('inference_stopped', {'message': '推理已停止'})

    @staticmethod
    def _device_str(device) -> str:
        """统一转为字符串，避免将 torch.device 对象传给 ultralytics 引发兼容问题"""
        return str(device)  # torch.device('cuda') -> 'cuda', torch.device('cpu') -> 'cpu'

    def _resolve_device(self, requested_device=None):
        """解析前端请求的设备；请求 CUDA 但不可用时回退到 CPU。"""
        requested = str(requested_device or '').strip().lower()
        if requested.startswith('cuda'):
            if torch.cuda.is_available():
                return torch.device(requested)
            return torch.device('cpu')
        if requested == 'cpu':
            return torch.device('cpu')
        return torch.device('cuda' if torch.cuda.is_available() else 'cpu')

    def _run_inference(self, params):
        """执行推理任务"""
        my_thread = threading.current_thread()
        try:
            input_type = params.get('input_type', 'image')
            self.current_input_type = input_type

            model_path = params.get('model_path')
            requested_device = params.get('device')
            resolved_device = self._resolve_device(requested_device)
            self.device = resolved_device

            # 如果模型未预加载或路径不匹配，则加载模型
            device_str = self._device_str(resolved_device)
            if str(requested_device or '').strip().lower().startswith('cuda') and device_str == 'cpu':
                self.socketio.emit('inference_status', {
                    'message': '未检测到可用 CUDA，已自动回退到 CPU'
                })
            if not self.model or self.model_path != model_path:
                self.socketio.emit('inference_status', {'message': f'正在加载模型: {os.path.basename(model_path)}'})
                model = YOLO(model_path)
                model.to(device_str)
                self.model = model
                self.model_path = model_path
                self.model_device = device_str
                self.current_task = registry.resolve_task(model)
                self.model_info = registry.describe_model(model, model_path)
                info = self.model_info
                self.socketio.emit('inference_status', {
                    'message': (
                        f"模型加载成功（{info.get('family_label')} · {info.get('task_label')}），"
                        f"类别数 {info.get('class_count')}，设备: {device_str}"
                    )
                })
            else:
                if self.model_device != device_str:
                    self.model.to(device_str)
                    self.model_device = device_str
                    self.socketio.emit('inference_status', {
                        'message': f'推理设备已切换为: {device_str}'
                    })
                if not self.current_task:
                    self.current_task = registry.resolve_task(self.model)
                self.socketio.emit('inference_status', {
                    'message': f"使用预加载模型（{self.current_task}），设备: {device_str}"
                })

            # 把任务类型同步给前端（模型决定，前端只做展示）
            self.socketio.emit('model_info', self.model_summary())

            # 根据输入类型 + 模型任务执行推理
            task = self.task()
            if input_type == 'image':
                self._inference_on_image(params)
            elif input_type == 'images':
                self._inference_on_images(params)
            elif input_type == 'video':
                if task == 'classify':
                    self._inference_on_video_classify(params)
                else:
                    self._inference_on_video(params)
            elif input_type == 'rtsp':
                if task == 'classify':
                    self._inference_on_rtsp_classify(params)
                else:
                    self._inference_on_rtsp(params)
            
        except BaseException as e:
            import traceback
            tb = traceback.format_exc()
            print(f"推理错误: {str(e)}\n{tb}")
            # 写入日志文件方便排查
            try:
                log_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'logs')
                os.makedirs(log_dir, exist_ok=True)
                with open(os.path.join(log_dir, 'inference_error.log'), 'a', encoding='utf-8') as f:
                    from datetime import datetime as _dt
                    f.write(f"[{_dt.now()}] model={params.get('model_path')} input={params.get('input_source')}\n")
                    f.write(tb + "\n")
            except Exception:
                pass
            self.socketio.emit('inference_error', {'message': f'推理失败: {str(e)}'})
        finally:
            # 仅当本线程仍是当前活跃推理线程时才重置状态
            # 防止旧线程清理时覆盖新线程已设好的 is_running=True
            if self.inference_thread is my_thread:
                self.is_running = False
                self.current_input_type = None
                if self.video_capture:
                    try:
                        self.video_capture.release()
                    except:
                        pass
                    self.video_capture = None
                if self.result_video_writer:
                    try:
                        self.result_video_writer.release()
                    except:
                        pass
                    self.result_video_writer = None
    
    def _inference_on_image(self, params):
        """图片推理（任务由模型决定：detect / segment / pose / obb / classify）"""
        input_path = params.get('input_path') or params.get('input_source', '')
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        selected_labels = params.get('selected_labels', [])
        task_type = self.task()
        roi_polygon = self._resolve_roi_polygon(params)
        
        self.socketio.emit('inference_status', {'message': f'开始图片推理（{task_type}）...'})
        
        # ── 分类模式 ──
        if task_type == 'classify':
            frame = cv2.imread(input_path)
            if frame is None:
                self.socketio.emit('inference_error', {'message': '无法读取图片'})
                return
            class_id, class_name, conf_value, annotated_image = self._classify_frame(
                frame, roi_polygon, params.get('label_aliases')
            )
            is_alarm = class_id in (params.get('alarm_labels') or [])
            
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            result_filename = f"result_{timestamp}.jpg"
            result_path = os.path.join(Config.get_results_dir(), result_filename)
            cv2.imwrite(result_path, annotated_image)
            image_base64 = self._image_to_base64(annotated_image)
            
            self.socketio.emit('inference_result', {
                'type': 'image',
                'image': image_base64,
                'result_path': result_path,
                'result_filename': result_filename,
                'detection_count': 1,
                'class_name': class_name,
                'confidence': conf_value,
                'is_alarm': is_alarm,
                'message': f'分类完成: {class_name} ({conf_value:.2f})'
            })
            # 命中报警类别则记录一条报警（单图每次推理都判定）
            self._maybe_emit_classify_alarm(
                params, annotated_image, class_id, class_name, conf_value, 'image', 0, interval=0
            )
            self.socketio.emit('inference_complete', {'message': '图片分类完成'})
            return
        
        # ── 检测类模式（detect / segment / pose / obb 走同一套框 + 可选掩膜/关键点）──
        # 不再传 task='pose'：任务由模型自身决定，强行覆盖会加载错误的 head。
        results = self.model(
            input_path,
            conf=confidence,
            iou=iou_threshold,
            device=self._device_str(self.device)
        )
        
        # 处理结果
        for result in results:
            # 按类别过滤（boxes / obb 都处理；pose 模型只有 person 一类，不做过滤）
            if task_type != 'pose':
                registry.filter_by_labels(result, selected_labels)
            
            # 如果启用ROI，ROI内的框显示为红色；否则用YOLO默认颜色（含掩膜/旋转框/骨架）
            if roi_polygon is not None:
                annotated_image, detection_count = self._annotate_with_roi_polygon(result, roi_polygon)
            else:
                annotated_image = result.plot()
                detection_count = registry.count_items(result)
            
            # 保存结果
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            result_filename = f"result_{timestamp}.jpg"
            result_path = os.path.join(Config.get_results_dir(), result_filename)
            cv2.imwrite(result_path, annotated_image)
            
            # 转换为base64发送到前端
            image_base64 = self._image_to_base64(annotated_image)
            
            self.socketio.emit('inference_result', {
                'type': 'image',
                'image': image_base64,
                'result_path': result_path,
                'result_filename': result_filename,
                'detection_count': detection_count,
                'task': task_type,
                'class_names': self._result_class_summary(result),
                'message': f'{registry.TASK_LABELS.get(task_type, task_type)}完成，发现 {detection_count} 个目标'
            })
        
        self.socketio.emit('inference_complete', {'message': '图片推理完成'})
        # is_running 由 _run_inference 的 finally 块统一重置
    def _inference_on_images(self, params):
        """批量图片推理"""
        input_paths = params.get('input_paths', [])
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        selected_labels = params.get('selected_labels', [])
        task_type = self.task()
        roi_polygon = self._resolve_roi_polygon(params)

        total = len(input_paths)
        if total == 0:
            self.socketio.emit('batch_complete', {'total': 0, 'message': '没有图片需要处理'})
            return

        if task_type == 'classify':
            self._inference_on_images_classify(params, input_paths, total, roi_polygon)
            return

        self.socketio.emit('inference_status', {'message': f'开始批量推理，共 {total} 张图片...'})

        processed = 0
        stopped = False

        for idx, input_path in enumerate(input_paths):
            if not self.is_running:
                stopped = True
                break

            filename = os.path.basename(input_path)
            self.socketio.emit('batch_progress', {
                'current': idx,
                'total': total,
                'filename': filename,
            })

            if not os.path.exists(input_path):
                self.socketio.emit('batch_item_result', {
                    'index': idx, 'total': total,
                    'filename': filename, 'image': '',
                    'detection_count': 0, 'error': '文件不存在',
                })
                processed += 1
                continue

            try:
                results = self.model(
                    input_path, conf=confidence, iou=iou_threshold,
                    device=self._device_str(self.device)
                )

                for result in results:
                    if task_type != 'pose':
                        registry.filter_by_labels(result, selected_labels)

                    if roi_polygon is not None:
                        annotated_image, detection_count = self._annotate_with_roi_polygon(result, roi_polygon)
                    else:
                        annotated_image = result.plot()
                        detection_count = registry.count_items(result)

                    image_base64 = self._image_to_base64(annotated_image)
                    self.socketio.emit('batch_item_result', {
                        'index': idx,
                        'total': total,
                        'filename': filename,
                        'image': image_base64,
                        'detection_count': detection_count,
                    })
                    processed += 1
            except Exception as e:
                self.socketio.emit('batch_item_result', {
                    'index': idx, 'total': total,
                    'filename': filename, 'image': '',
                    'detection_count': 0, 'error': str(e),
                })
                processed += 1

        if stopped:
            self.socketio.emit('inference_stopped', {
                'message': f'批量推理已停止，已处理 {processed}/{total} 张',
            })
        else:
            self.socketio.emit('batch_complete', {
                'total': total,
                'processed': processed,
                'message': f'批量推理完成，共处理 {processed}/{total} 张图片',
            })
    def _inference_on_video(self, params):
        """视频推理（任务由模型决定）"""
        input_path = params.get('input_path') or params.get('input_source', '')
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        task_type = self.task()
        selected_labels = params.get('selected_labels', [])
        roi_polygon = self._resolve_roi_polygon(params)
        tracking_enabled = params.get('tracking_enabled', False)
        tracker_type = params.get('tracker', 'bytetrack')
        
        self.socketio.emit('inference_status', {'message': '开始视频推理...'})
        
        # 用局部变量持有本次打开的资源，避免被新线程的 self.video_capture 覆盖后误释放
        cap = cv2.VideoCapture(input_path)
        self.video_capture = cap  # 供 stop_inference 释放
        if not cap.isOpened():
            self.video_capture = None
            self.socketio.emit('inference_error', {'message': '无法打开视频文件'})
            return
        
        # 获取视频属性
        fps = int(cap.get(cv2.CAP_PROP_FPS))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        # 推理帧率控制：每秒推理10帧
        target_inference_fps = 10
        frame_skip = max(1, int(fps / target_inference_fps))  # 计算跳帧间隔
        print(f"视频FPS: {fps}, 推理FPS: {target_inference_fps}, 跳帧间隔: {frame_skip}")
        
        # 创建结果视频写入器
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        result_filename = f"result_{timestamp}.mp4"
        result_path = os.path.join(Config.get_results_dir(), result_filename)
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(result_path, fourcc, fps, (width, height))
        self.result_video_writer = writer  # 供 stop_inference 释放
        
        frame_count = 0
        inference_count = 0  # 实际推理的帧数
        start_time = time.time()
        
        # 缓存最后一次检测结果，用于跳帧时复用
        last_detections = []
        last_detection_count = 0
        last_roi_polygon = roi_polygon
        
        while self.is_running:
            # 用局部 cap，不受 self.video_capture 被新线程覆盖的影响
            if not cap.isOpened():
                break
                
            ret, frame = cap.read()
            if not ret:
                break
            
            frame_count += 1
            
            # 跳帧控制：只对特定帧进行推理
            should_inference = (frame_count % frame_skip == 0)
            
            if should_inference:
                inference_count += 1
                
                # 执行推理（任务由模型决定，不传 task 覆盖）
                if tracking_enabled and task_type in ('detect', 'segment', 'obb'):
                    results = self.model.track(
                        frame,
                        conf=confidence,
                        iou=iou_threshold,
                        persist=True,
                        tracker=f"{tracker_type}.yaml",
                        device=self._device_str(self.device)
                    )
                else:
                    results = self.model(
                        frame,
                        conf=confidence,
                        iou=iou_threshold,
                        device=self._device_str(self.device)
                    )
                
                # 处理结果
                for result in results:
                    # 过滤标签（boxes / obb 均处理；pose 只有 person 一类）
                    if task_type != 'pose':
                        registry.filter_by_labels(result, selected_labels)
                    
                    # 绘制检测框（ROI内红色，ROI外默认颜色）
                    if roi_polygon is not None:
                        annotated_frame, _ = self._annotate_with_roi_polygon(result, roi_polygon)
                    else:
                        annotated_frame = result.plot()

                    # 写入结果视频（检查写入器是否存在且有效）
                    try:
                        if writer is not None:
                            writer.write(annotated_frame)
                    except Exception:
                        pass
                    
                    # 提取检测框数据（归一化坐标，兼容 boxes / obb）
                    detections = []
                    detection_count = 0

                    for item in registry.iter_items(result):
                        detection = {
                            'x1': item['box'][0],
                            'y1': item['box'][1],
                            'x2': item['box'][2],
                            'y2': item['box'][3],
                            'confidence': item['confidence'],
                            'class': item['class_id'],
                            'class_name': item['class_name'],
                        }
                        if item['quad'] is not None:
                            detection['quad'] = [list(p) for p in item['quad']]
                        if roi_polygon is not None:
                            if self._point_in_polygon(item['center'][0], item['center'][1], roi_polygon):
                                detections.append(detection)
                                detection_count += 1
                        else:
                            detections.append(detection)
                            detection_count += 1
                    
                    # 缓存本次检测结果
                    last_detections = detections
                    last_detection_count = detection_count
                    last_roi_polygon = roi_polygon

                    # 发送实时预览帧（缩小到 640px 宽以减少传输量）
                    elapsed_time = time.time() - start_time
                    fps_actual = inference_count / elapsed_time if elapsed_time > 0 else 0
                    try:
                        preview_h, preview_w = annotated_frame.shape[:2]
                        if preview_w > 640:
                            scale = 640 / preview_w
                            preview = cv2.resize(annotated_frame, (640, int(preview_h * scale)))
                        else:
                            preview = annotated_frame
                        _, buf = cv2.imencode('.jpg', preview, [cv2.IMWRITE_JPEG_QUALITY, 75])
                        frame_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode('utf-8')
                        self.socketio.emit('inference_progress', {
                            'image': frame_b64,
                            'frame': frame_count,
                            'fps': fps_actual,
                            'detection_count': detection_count,
                        })
                    except Exception:
                        pass
                    
                    # 报警图生成逻辑
                    if detection_count > 0:
                        alarm_interval = params.get('alarm_interval', 5)
                        if not hasattr(self, 'last_alarm_time'):
                            self.last_alarm_time = 0
                        current_time_stamp = time.time()
                        if current_time_stamp - self.last_alarm_time >= alarm_interval:
                            timestamp_str = datetime.now().strftime('%Y%m%d_%H%M%S')
                            alarm_filename = f'alarm_{timestamp_str}_{frame_count}.jpg'
                            alarm_dir = os.path.join('static', 'alarmimage')
                            os.makedirs(alarm_dir, exist_ok=True)
                            alarm_path = os.path.join(alarm_dir, alarm_filename)
                            cv2.imwrite(alarm_path, annotated_frame)
                            self.last_alarm_time = current_time_stamp
                            self.socketio.emit('alarm_triggered', {
                                'input_type': 'video',
                                'source_type': 'video',
                                'filename': alarm_filename,
                                'count': detection_count,
                                'timestamp': timestamp_str
                            })
                
                # 发送推理进度
                elapsed_time = time.time() - start_time
                progress = (frame_count / total_frames) * 100 if total_frames > 0 else 0
                fps_actual = inference_count / elapsed_time if elapsed_time > 0 else 0
                current_time = frame_count / fps if fps > 0 else 0
                self.socketio.emit('inference_detections', {
                    'frame': frame_count,
                    'inference_frame': inference_count,
                    'timestamp': current_time,
                    'detections': last_detections,
                    'detection_count': last_detection_count,
                    'progress': progress,
                    'fps': fps_actual,
                    'total_frames': total_frames,
                    'roi': last_roi_polygon
                })
        
        # 释放本函数打开的资源（局部变量引用，不受新线程影响）
        try:
            cap.release()
        except Exception:
            pass
        try:
            writer.release()
        except Exception:
            pass
        # 只有实例变量仍指向本次资源时才清除，防止覆盖新线程已设置的值
        if self.video_capture is cap:
            self.video_capture = None
        if self.result_video_writer is writer:
            self.result_video_writer = None

        # 只在正常完成且本线程仍是活跃推理线程时才发送（防止旧线程在新推理已启动后误发）
        if self.is_running and self.inference_thread is threading.current_thread():
            elapsed_time = time.time() - start_time
            avg_inference_fps = inference_count / elapsed_time if elapsed_time > 0 else 0
            self.socketio.emit('inference_complete', {
                'message': f'视频推理完成，视频总帧数 {frame_count}，实际推理 {inference_count} 帧，平均推理帧率 {avg_inference_fps:.1f} FPS',
                'result_path': result_path,
                'result_filename': result_filename
            })
        # is_running 由 _run_inference 的 finally 块统一重置，此处不再重复设置

    def _inference_on_rtsp(self, params):
        """RTSP流推理"""
        rtsp_url = params.get('input_path') or params.get('input_source', '')
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        task_type = self.task()
        selected_labels = params.get('selected_labels', [])
        roi_polygon = self._resolve_roi_polygon(params)
        tracking_enabled = params.get('tracking_enabled', False)
        tracker_type = params.get('tracker', 'bytetrack')
        
        self.socketio.emit('inference_status', {'message': f'正在连接RTSP流: {rtsp_url}'})
        
        # 用局部变量持有本次连接，避免被新线程覆盖后误释放
        cap = cv2.VideoCapture(rtsp_url)
        self.video_capture = cap  # 供 stop_inference 释放
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        
        if not cap.isOpened():
            self.video_capture = None
            self.socketio.emit('inference_error', {'message': '无法连接RTSP流'})
            return
        
        self.socketio.emit('inference_status', {'message': 'RTSP流连接成功，开始推理...'})
        
        frame_count = 0
        start_time = time.time()
        
        while self.is_running:
            if not cap.isOpened():
                break
                
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.1)
                continue
            
            frame_count += 1
            
            # 执行推理（任务由模型决定）
            if tracking_enabled and task_type in ('detect', 'segment', 'obb'):
                results = self.model.track(
                    frame,
                    conf=confidence,
                    iou=iou_threshold,
                    persist=True,
                    tracker=f"{tracker_type}.yaml",
                    device=self._device_str(self.device)
                )
            else:
                results = self.model(
                    frame,
                    conf=confidence,
                    iou=iou_threshold,
                    device=self._device_str(self.device)
                )
            
            # 处理结果
            for result in results:
                # 过滤标签（boxes / obb 均处理）
                if task_type != 'pose':
                    registry.filter_by_labels(result, selected_labels)
                
                # 如果启用ROI，ROI内的框显示为红色；否则用YOLO默认颜色
                if roi_polygon is not None:
                    annotated_frame, detection_count = self._annotate_with_roi_polygon(result, roi_polygon)
                else:
                    # 不启用ROI时，绘制全部结果（含掩膜 / 旋转框 / 骨架）
                    annotated_frame = result.plot()
                    detection_count = registry.count_items(result)
                
                # 报警图生成逻辑
                if detection_count > 0:  # 有目标时生成报警图
                    alarm_interval = params.get('alarm_interval', 5)  # 默认5秒
                    
                    # 检查是否到达报警间隔
                    if not hasattr(self, 'last_alarm_time'):
                        self.last_alarm_time = 0
                    
                    current_time_stamp = time.time()
                    if current_time_stamp - self.last_alarm_time >= alarm_interval:
                        # 生成报警图片，保存到static/alarmimage目录
                        timestamp_str = datetime.now().strftime('%Y%m%d_%H%M%S')
                        alarm_filename = f'alarm_{timestamp_str}_{frame_count}.jpg'
                        alarm_dir = os.path.join('static', 'alarmimage')
                        os.makedirs(alarm_dir, exist_ok=True)
                        alarm_path = os.path.join(alarm_dir, alarm_filename)
                        cv2.imwrite(alarm_path, annotated_frame)
                        
                        # 更新最后报警时间
                        self.last_alarm_time = current_time_stamp
                        
                        # 发送报警事件到前端（使用文件路径）
                        self.socketio.emit('alarm_triggered', {
                            'input_type': 'rtsp',
                            'source_type': 'rtsp',
                            'filename': alarm_filename,
                            'count': detection_count,
                            'timestamp': timestamp_str
                        })
                
                # 发送预览
                image_base64 = self._image_to_base64(annotated_frame)
                
                elapsed_time = time.time() - start_time
                fps_actual = frame_count / elapsed_time if elapsed_time > 0 else 0
                
                self.socketio.emit('inference_progress', {
                    'image': image_base64,  # _image_to_base64已经包含了data URI前缀
                    'frame': frame_count,
                    'fps': fps_actual,
                    'detection_count': detection_count
                })
            
            # 控制帧率
            time.sleep(0.03)
        
        # 释放本函数打开的资源
        try:
            cap.release()
        except Exception:
            pass
        if self.video_capture is cap:
            self.video_capture = None

        # 只在正常结束且本线程仍是活跃推理线程时才发送（防止旧线程误发）
        if self.is_running and self.inference_thread is threading.current_thread():
            self.socketio.emit('inference_complete', {
                'message': f'RTSP推理已停止，共处理 {frame_count} 帧'
            })
        # is_running 由 _run_inference 的 finally 块统一重置

    def _image_to_base64(self, image):
        """将图像转换为base64字符串"""
        # 转换为RGB
        if len(image.shape) == 3 and image.shape[2] == 3:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        
        # 转换为PIL图像
        pil_image = Image.fromarray(image)
        
        # 限制到720P以控制传输量，同时保持清晰度
        max_size = (1280, 720)
        pil_image.thumbnail(max_size, Image.Resampling.LANCZOS)
        
        buffer = io.BytesIO()
        pil_image.save(buffer, format='JPEG', quality=80)
        img_str = base64.b64encode(buffer.getvalue()).decode()
        
        return f"data:image/jpeg;base64,{img_str}"
    
    def _get_class_name(self, class_id):
        """获取类别名称"""
        if self.model and hasattr(self.model, 'names'):
            return self.model.names.get(class_id, f'Class {class_id}')
        return f'Class {class_id}'

    def _result_class_summary(self, result) -> dict:
        """统计各类别数量：{类名: 个数}，供前端做结果说明。"""
        summary = {}
        for item in registry.iter_items(result):
            name = item['class_name']
            summary[name] = summary.get(name, 0) + 1
        return summary

    # ─── ROI 多边形解析 ──────────────────────────────────────
    def _resolve_roi_polygon(self, params):
        """解析 ROI 多边形（归一化坐标点列表 [[x,y], ...]）。
        优先级：前端传入的 roi_polygon > roi_json_path 文件 > 旧矩形 roi_coords。
        未启用 ROI 或无有效数据时返回 None（整图）。
        分类任务下，只要提供了 ROI 数据就直接应用（不依赖 roi_enabled 开关）。"""
        task_type = self.task()
        roi_enabled = params.get('roi_enabled', False)
        if not roi_enabled and task_type != 'classify':
            return None

        pts = self._normalize_polygon(params.get('roi_polygon'))
        if pts:
            return pts

        json_path = params.get('roi_json_path')
        if json_path and os.path.exists(json_path):
            pts = self._parse_roi_json(json_path)
            if pts:
                return pts

        rect = params.get('roi_coords')
        if rect and isinstance(rect, (list, tuple)) and len(rect) == 4:
            try:
                x1, y1, x2, y2 = (float(v) for v in rect)
                return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
            except (TypeError, ValueError):
                pass
        return None

    def _normalize_polygon(self, poly):
        """把 [[x,y],...] 转为 float 点列表；无效返回 None。"""
        if not isinstance(poly, list) or len(poly) < 3:
            return None
        pts = []
        for p in poly:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                try:
                    pts.append([float(p[0]), float(p[1])])
                except (TypeError, ValueError):
                    continue
        return pts if len(pts) >= 3 else None

    def _parse_roi_json(self, json_path):
        """读取 ROI JSON 文件并提取 polygon 顶点。"""
        try:
            import json
            with open(json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                return self._normalize_polygon(data.get('polygon'))
        except Exception as e:
            print(f"解析ROI JSON失败: {e}")
        return None

    def _point_in_polygon(self, x, y, poly):
        """射线法判断点 (x,y) 是否在多边形内（含边界）。"""
        inside = False
        n = len(poly)
        j = n - 1
        for i in range(n):
            xi, yi = poly[i]
            xj, yj = poly[j]
            if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    def _extract_roi_region(self, image, polygon_norm):
        """按归一化多边形抠图：轮廓外置黑，返回多边形外接矩形裁剪结果。
        与训练时抠图方式一致，避免推理区域与训练区域不一致。"""
        h, w = image.shape[:2]
        pts = np.array(
            [[int(round(x * w)), int(round(y * h))] for x, y in polygon_norm],
            dtype=np.int32
        )
        mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(mask, [pts], 255)
        black = np.zeros_like(image)
        masked = np.where(mask[..., None] == 255, image, black)
        x, y, ww, hh = cv2.boundingRect(pts)
        return masked[y:y + hh, x:x + ww]

    def _annotate_classify(self, frame, polygon_norm):
        """在原始帧上绘制 ROI 多边形轮廓。
        分类结果文字（含中文）改由前端浮层展示，避免 OpenCV putText 中文乱码。"""
        annotated = frame.copy()
        if polygon_norm is not None:
            h, w = annotated.shape[:2]
            pts = np.array(
                [[int(round(x * w)), int(round(y * h))] for x, y in polygon_norm],
                dtype=np.int32
            )
            cv2.polylines(annotated, [pts], True, (0, 230, 118), 2)
        return annotated

    def _classify_frame(self, frame, polygon_norm, aliases=None):
        """对单帧执行分类，返回 (class_id, class_name, conf, annotated_frame)。
        aliases 为标签翻译（dict 或按类别 id 索引的 list），命中则用翻译后的名称展示。"""
        input_img = frame
        if polygon_norm is not None:
            crop = self._extract_roi_region(frame, polygon_norm)
            if crop is not None and crop.size > 0:
                input_img = crop

        results = self.model(input_img, device=self._device_str(self.device))
        class_id = -1
        class_name = "unknown"
        conf = 0.0
        for r in results:
            if hasattr(r, 'probs') and r.probs is not None:
                class_id = int(r.probs.top1)
                class_name = self._get_class_name(class_id)
                alias = self._resolve_alias(class_id, aliases)
                if alias:
                    class_name = alias
                conf = float(r.probs.top1conf)
                break
        annotated = self._annotate_classify(frame, polygon_norm)
        return class_id, class_name, conf, annotated

    def _resolve_alias(self, class_id, aliases):
        """从标签翻译表取类别中文名；无有效翻译返回 None。"""
        if not aliases:
            return None
        if isinstance(aliases, dict):
            v = aliases.get(class_id) or aliases.get(str(class_id))
            return v.strip() if isinstance(v, str) and v.strip() else None
        if isinstance(aliases, (list, tuple)) and 0 <= class_id < len(aliases):
            v = aliases[class_id]
            return v.strip() if isinstance(v, str) and v.strip() else None
        return None

    def _maybe_emit_classify_alarm(self, params, annotated, class_id, class_name, conf,
                                   source_type, frame_count=0, interval=None):
        """分类结果命中报警类别时，保存报警图并推送报警事件（带节流）。
        alarm_labels 为空表示不报警；interval 为 None 时使用 alarm_interval（默认 5 秒）。"""
        alarm_labels = params.get('alarm_labels', [])
        if not alarm_labels or class_id not in alarm_labels:
            return

        alarm_interval = interval if interval is not None else params.get('alarm_interval', 5)
        now = time.time()
        last = getattr(self, 'last_classify_alarm_time', 0)
        if now - last < alarm_interval:
            return
        self.last_classify_alarm_time = now

        timestamp_str = datetime.now().strftime('%Y%m%d_%H%M%S')
        alarm_filename = f"alarm_{timestamp_str}_{frame_count}.jpg"
        alarm_dir = os.path.join('static', 'alarmimage')
        os.makedirs(alarm_dir, exist_ok=True)
        cv2.imwrite(os.path.join(alarm_dir, alarm_filename), annotated)

        self.socketio.emit('alarm_triggered', {
            'input_type': source_type,
            'source_type': source_type,
            'filename': alarm_filename,
            'count': 1,
            'class_name': class_name,
            'confidence': conf,
            'timestamp': timestamp_str,
        })

    def _annotate_with_roi_polygon(self, result, polygon_norm):
        """绘制结果：ROI 多边形内的目标用红色描边，并画出多边形轮廓。

        同时兼容三种几何形状：
        - 普通框（detect / segment / pose）→ 轴对齐矩形
        - 旋转框（obb）→ 4 角点折线
        掩膜与骨架仍由 `result.plot()` 负责，这里只做 ROI 内高亮与中文安全的标签。
        返回 (annotated_frame, inside_count)。
        """
        annotated = result.plot()
        inside_count = 0

        h, w = annotated.shape[:2]
        pts = np.array(
            [[int(round(x * w)), int(round(y * h))] for x, y in polygon_norm],
            dtype=np.int32
        )
        # 先画 ROI 轮廓：即使没有目标，用户也能看到区域位置
        cv2.polylines(annotated, [pts], True, (0, 230, 118), 2)

        for item in registry.iter_items(result):
            cx, cy = item['center']
            if not self._point_in_polygon(cx, cy, polygon_norm):
                continue
            inside_count += 1

            if item['quad']:
                quad = np.array(
                    [[int(round(px * w)), int(round(py * h))] for px, py in item['quad']],
                    dtype=np.int32
                )
                cv2.polylines(annotated, [quad], True, (0, 0, 255), 3)
                anchor_x = int(quad[:, 0].min())
                anchor_y = int(quad[:, 1].min())
            else:
                bx1, by1, bx2, by2 = item['box']
                px1, py1 = int(bx1 * w), int(by1 * h)
                px2, py2 = int(bx2 * w), int(by2 * h)
                cv2.rectangle(annotated, (px1, py1), (px2, py2), (0, 0, 255), 3)
                anchor_x, anchor_y = px1, py1

            label = f"{item['class_name']} {item['confidence']:.2f}"
            (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(
                annotated,
                (anchor_x, anchor_y - th - baseline - 2),
                (anchor_x + tw + 2, anchor_y),
                (0, 0, 255),
                -1,
            )
            cv2.putText(
                annotated, label,
                (anchor_x + 1, anchor_y - baseline - 1),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1,
            )

        return annotated, inside_count

    # ─── 分类推理（批量图片 / 视频 / RTSP）────────────────────
    def _inference_on_images_classify(self, params, input_paths, total, roi_polygon):
        """批量图片分类推理"""
        self.socketio.emit('inference_status', {'message': f'开始批量分类，共 {total} 张图片...'})
        processed = 0

        for idx, input_path in enumerate(input_paths):
            if not self.is_running:
                break
            filename = os.path.basename(input_path)
            self.socketio.emit('batch_progress', {
                'current': idx, 'total': total, 'filename': filename,
            })

            if not os.path.exists(input_path):
                self.socketio.emit('batch_item_result', {
                    'index': idx, 'total': total,
                    'filename': filename, 'image': '',
                    'detection_count': 0, 'error': '文件不存在',
                })
                processed += 1
                continue

            try:
                frame = cv2.imread(input_path)
                if frame is None:
                    raise ValueError('无法读取图片')
                class_id, class_name, conf_value, annotated = self._classify_frame(
                    frame, roi_polygon, params.get('label_aliases')
                )
                image_base64 = self._image_to_base64(annotated)
                self.socketio.emit('batch_item_result', {
                    'index': idx, 'total': total,
                    'filename': filename, 'image': image_base64,
                    'detection_count': 1,
                    'class_name': class_name,
                    'confidence': conf_value,
                })
                # 命中报警类别则记录一条报警（批量每张命中图各一条）
                self._maybe_emit_classify_alarm(
                    params, annotated, class_id, class_name, conf_value, 'image', idx, interval=0
                )
                processed += 1
            except Exception as e:
                self.socketio.emit('batch_item_result', {
                    'index': idx, 'total': total,
                    'filename': filename, 'image': '',
                    'detection_count': 0, 'error': str(e),
                })
                processed += 1

        if self.is_running:
            self.socketio.emit('batch_complete', {
                'total': total,
                'processed': processed,
                'message': f'批量分类完成，共处理 {processed}/{total} 张图片',
            })
        else:
            self.socketio.emit('inference_stopped', {
                'message': f'批量分类已停止，已处理 {processed}/{total} 张',
            })

    def _inference_on_video_classify(self, params):
        """视频分类推理"""
        input_path = params.get('input_path') or params.get('input_source', '')
        roi_polygon = self._resolve_roi_polygon(params)

        self.socketio.emit('inference_status', {'message': '开始视频分类推理...'})

        cap = cv2.VideoCapture(input_path)
        self.video_capture = cap
        if not cap.isOpened():
            self.video_capture = None
            self.socketio.emit('inference_error', {'message': '无法打开视频文件'})
            return

        fps = int(cap.get(cv2.CAP_PROP_FPS)) or 25
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        result_filename = f"result_{timestamp}.mp4"
        result_path = os.path.join(Config.get_results_dir(), result_filename)
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(result_path, fourcc, fps, (width, height))
        self.result_video_writer = writer

        frame_count = 0
        start_time = time.time()
        last_class_name = ""
        last_conf = 0.0

        while self.is_running:
            ret, frame = cap.read()
            if not ret:
                break
            frame_count += 1
            class_id, class_name, conf_value, annotated = self._classify_frame(
                frame, roi_polygon, params.get('label_aliases')
            )
            is_alarm = class_id in (params.get('alarm_labels') or [])
            last_class_name, last_conf = class_name, conf_value

            try:
                if writer is not None:
                    writer.write(annotated)
            except Exception:
                pass

            # 命中报警类别则按间隔记录报警（默认 5 秒节流）
            self._maybe_emit_classify_alarm(
                params, annotated, class_id, class_name, conf_value, 'video', frame_count
            )

            elapsed = time.time() - start_time
            fps_actual = frame_count / elapsed if elapsed > 0 else 0
            try:
                preview_h, preview_w = annotated.shape[:2]
                if preview_w > 640:
                    scale = 640 / preview_w
                    preview = cv2.resize(annotated, (640, int(preview_h * scale)))
                else:
                    preview = annotated
                _, buf = cv2.imencode('.jpg', preview, [cv2.IMWRITE_JPEG_QUALITY, 75])
                frame_b64 = "data:image/jpeg;base64," + base64.b64encode(buf).decode('utf-8')
                self.socketio.emit('inference_progress', {
                    'image': frame_b64,
                    'frame': frame_count,
                    'fps': fps_actual,
                    'detection_count': 1,
                    'class_name': class_name,
                    'confidence': conf_value,
                    'is_alarm': is_alarm,
                })
            except Exception:
                pass

        try:
            cap.release()
        except Exception:
            pass
        try:
            writer.release()
        except Exception:
            pass
        if self.video_capture is cap:
            self.video_capture = None
        if self.result_video_writer is writer:
            self.result_video_writer = None

        if self.is_running and self.inference_thread is threading.current_thread():
            self.socketio.emit('inference_complete', {
                'message': f'视频分类推理完成，共处理 {frame_count} 帧，最后类别: {last_class_name} ({last_conf:.2f})',
                'result_path': result_path,
                'result_filename': result_filename
            })

    def _inference_on_rtsp_classify(self, params):
        """RTSP流分类推理"""
        rtsp_url = params.get('input_path') or params.get('input_source', '')
        roi_polygon = self._resolve_roi_polygon(params)

        self.socketio.emit('inference_status', {'message': f'正在连接RTSP流: {rtsp_url}'})

        cap = cv2.VideoCapture(rtsp_url)
        self.video_capture = cap
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            self.video_capture = None
            self.socketio.emit('inference_error', {'message': '无法连接RTSP流'})
            return

        self.socketio.emit('inference_status', {'message': 'RTSP流连接成功，开始分类推理...'})

        frame_count = 0
        start_time = time.time()

        while self.is_running:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.1)
                continue
            frame_count += 1
            class_id, class_name, conf_value, annotated = self._classify_frame(
                frame, roi_polygon, params.get('label_aliases')
            )
            is_alarm = class_id in (params.get('alarm_labels') or [])

            # 命中报警类别则按间隔记录报警（默认 5 秒节流）
            self._maybe_emit_classify_alarm(
                params, annotated, class_id, class_name, conf_value, 'rtsp', frame_count
            )

            image_base64 = self._image_to_base64(annotated)
            elapsed = time.time() - start_time
            fps_actual = frame_count / elapsed if elapsed > 0 else 0
            self.socketio.emit('inference_progress', {
                'image': image_base64,
                'frame': frame_count,
                'fps': fps_actual,
                'detection_count': 1,
                'class_name': class_name,
                'confidence': conf_value,
                'is_alarm': is_alarm,
            })

            time.sleep(0.03)

        try:
            cap.release()
        except Exception:
            pass
        if self.video_capture is cap:
            self.video_capture = None

        if self.is_running and self.inference_thread is threading.current_thread():
            self.socketio.emit('inference_complete', {
                'message': f'RTSP分类推理已停止，共处理 {frame_count} 帧'
            })
