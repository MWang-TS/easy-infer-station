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
    
    def load_model(self, model_path):
        """预加载模型到内存"""
        try:
            # 如果已经加载了相同的模型，跳过
            if self.model and self.model_path == model_path:
                print(f"模型已加载: {model_path}")
                return True
            
            print(f"开始加载模型: {model_path}")
            self.model = YOLO(model_path)
            device_str = self._device_str(self.device)
            self.model.to(device_str)
            self.model_path = model_path
            self.model_device = device_str
            print(f"模型加载成功，使用设备: {device_str}")
            return True
        except Exception as e:
            print(f"预加载模型失败: {str(e)}")
            self.model = None
            self.model_path = None
            self.model_device = None
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
        if not model_path or not os.path.exists(model_path):
            self.socketio.emit('inference_error', {'message': '模型文件不存在'})
            return

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
                self.model = YOLO(model_path)
                self.model.to(device_str)
                self.model_path = model_path
                self.model_device = device_str
                self.socketio.emit('inference_status', {
                    'message': f'模型加载成功，使用设备: {device_str}'
                })
            else:
                if self.model_device != device_str:
                    self.model.to(device_str)
                    self.model_device = device_str
                    self.socketio.emit('inference_status', {
                        'message': f'推理设备已切换为: {device_str}'
                    })
                self.socketio.emit('inference_status', {
                    'message': f'使用预加载模型，设备: {device_str}'
                })

            # 根据输入类型执行推理
            if input_type == 'image':
                self._inference_on_image(params)
            elif input_type == 'images':
                self._inference_on_images(params)
            elif input_type == 'video':
                self._inference_on_video(params)
            elif input_type == 'rtsp':
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
        """图片推理"""
        input_path = params.get('input_path') or params.get('input_source', '')
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        pose_mode = params.get('pose_mode_enabled', False)
        selected_labels = params.get('selected_labels', [])
        roi_enabled = params.get('roi_enabled', False)
        roi_coords = params.get('roi_coords')
        
        self.socketio.emit('inference_status', {'message': '开始图片推理...'})
        
        # 执行推理
        if pose_mode:
            results = self.model(
                input_path,
                conf=confidence,
                iou=iou_threshold,
                task='pose',
                device=self._device_str(self.device)
            )
        else:
            results = self.model(
                input_path,
                conf=confidence,
                iou=iou_threshold,
                device=self._device_str(self.device)
            )
        
        # 处理结果
        for result in results:
            # 过滤标签
            if not pose_mode and selected_labels and len(result.boxes.cls) > 0:
                keep_mask = torch.tensor([int(cls.item()) in selected_labels for cls in result.boxes.cls])
                result.boxes = result.boxes[keep_mask]
            
            # 获取原始图像
            original_image = cv2.imread(input_path)
            
            # 如果启用ROI，ROI内的框显示为红色；否则用YOLO默认颜色
            if roi_enabled and roi_coords:
                annotated_image, detection_count = self._annotate_with_roi(result, roi_coords)
            else:
                # 不启用ROI时，绘制所有检测框
                annotated_image = result.plot()
                detection_count = len(result.boxes) if hasattr(result, 'boxes') and result.boxes is not None else 0
            
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
                'message': f'检测完成，发现 {detection_count} 个目标'
            })
        
        self.socketio.emit('inference_complete', {'message': '图片推理完成'})
        # is_running 由 _run_inference 的 finally 块统一重置
    def _inference_on_images(self, params):
        """批量图片推理"""
        input_paths = params.get('input_paths', [])
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        pose_mode = params.get('pose_mode_enabled', False)
        selected_labels = params.get('selected_labels', [])
        roi_enabled = params.get('roi_enabled', False)
        roi_coords = params.get('roi_coords')

        total = len(input_paths)
        if total == 0:
            self.socketio.emit('batch_complete', {'total': 0, 'message': '没有图片需要处理'})
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
                if pose_mode:
                    results = self.model(
                        input_path, conf=confidence, iou=iou_threshold,
                        task='pose', device=self._device_str(self.device)
                    )
                else:
                    results = self.model(
                        input_path, conf=confidence, iou=iou_threshold,
                        device=self._device_str(self.device)
                    )

                for result in results:
                    if not pose_mode and selected_labels and len(result.boxes.cls) > 0:
                        keep_mask = torch.tensor([int(cls.item()) in selected_labels for cls in result.boxes.cls])
                        result.boxes = result.boxes[keep_mask]

                    if roi_enabled and roi_coords:
                        annotated_image, detection_count = self._annotate_with_roi(result, roi_coords)
                    else:
                        annotated_image = result.plot()
                        detection_count = len(result.boxes) if hasattr(result, 'boxes') and result.boxes is not None else 0

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
        """视频推理"""
        input_path = params.get('input_path') or params.get('input_source', '')
        confidence = params.get('confidence', 0.5)
        iou_threshold = params.get('iou', params.get('iou_threshold', 0.45))
        pose_mode = params.get('pose_mode_enabled', False)
        selected_labels = params.get('selected_labels', [])
        roi_enabled = params.get('roi_enabled', False)
        roi_coords = params.get('roi_coords')
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
        last_roi_coords = roi_coords if roi_enabled else None
        
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
                
                # 执行推理
                if pose_mode:
                    results = self.model(
                        frame,
                        conf=confidence,
                        iou=iou_threshold,
                        task='pose',
                        device=self._device_str(self.device)
                    )
                elif tracking_enabled:
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
                    # 过滤标签
                    if not pose_mode and selected_labels and len(result.boxes.cls) > 0:
                        keep_mask = torch.tensor([int(cls.item()) in selected_labels for cls in result.boxes.cls])
                        result.boxes = result.boxes[keep_mask]
                    
                    # 绘制检测框（ROI内红色，ROI外默认颜色）
                    if roi_enabled and roi_coords:
                        annotated_frame, _ = self._annotate_with_roi(result, roi_coords)
                    else:
                        annotated_frame = result.plot()

                    # 写入结果视频（检查写入器是否存在且有效）
                    try:
                        if writer is not None:
                            writer.write(annotated_frame)
                    except Exception:
                        pass
                    
                    # 提取检测框数据（归一化坐标）
                    detections = []
                    detection_count = 0
                    
                    if hasattr(result, 'boxes') and result.boxes is not None and len(result.boxes) > 0:
                        h, w = frame.shape[:2]
                        
                        for box, conf, cls in zip(result.boxes.xyxy, result.boxes.conf, result.boxes.cls):
                            x1, y1, x2, y2 = box.cpu().numpy()
                            detection = {
                                'x1': float(x1 / w),
                                'y1': float(y1 / h),
                                'x2': float(x2 / w),
                                'y2': float(y2 / h),
                                'confidence': float(conf.cpu().numpy()),
                                'class': int(cls.cpu().numpy()),
                                'class_name': self._get_class_name(int(cls.cpu().numpy()))
                            }
                            if roi_enabled and roi_coords:
                                center_x = (detection['x1'] + detection['x2']) / 2
                                center_y = (detection['y1'] + detection['y2']) / 2
                                if roi_coords[0] <= center_x <= roi_coords[2] and roi_coords[1] <= center_y <= roi_coords[3]:
                                    detections.append(detection)
                                    detection_count += 1
                            else:
                                detections.append(detection)
                                detection_count += 1
                    else:
                        detection_count = 0
                    
                    # 缓存本次检测结果
                    last_detections = detections
                    last_detection_count = detection_count
                    last_roi_coords = roi_coords if roi_enabled else None

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
                    'roi': last_roi_coords
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
        pose_mode = params.get('pose_mode_enabled', False)
        selected_labels = params.get('selected_labels', [])
        roi_enabled = params.get('roi_enabled', False)
        roi_coords = params.get('roi_coords')
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
            
            # 执行推理
            if pose_mode:
                results = self.model(
                    frame,
                    conf=confidence,
                    iou=iou_threshold,
                    task='pose',
                    device=self._device_str(self.device)
                )
            elif tracking_enabled:
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
                # 过滤标签
                if not pose_mode and selected_labels and len(result.boxes.cls) > 0:
                    keep_mask = torch.tensor([int(cls.item()) in selected_labels for cls in result.boxes.cls])
                    result.boxes = result.boxes[keep_mask]
                
                # 如果启用ROI，ROI内的框显示为红色；否则用YOLO默认颜色
                if roi_enabled and roi_coords:
                    annotated_frame, detection_count = self._annotate_with_roi(result, roi_coords)
                else:
                    # 不启用ROI时，绘制所有检测框
                    annotated_frame = result.plot()
                    detection_count = len(result.boxes) if hasattr(result, 'boxes') and result.boxes is not None else 0
                
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
    
    def _count_detections_in_roi(self, result, roi_coords):
        """计算ROI区域内的检测数量"""
        if not hasattr(result, 'boxes') or result.boxes is None or len(result.boxes) == 0:
            return 0
        
        x1, y1, x2, y2 = roi_coords
        count = 0
        
        # 遍历所有检测框
        for box in result.boxes.xyxyn:  # xyxyn是归一化坐标
            bx1, by1, bx2, by2 = box[:4].cpu().numpy()
            
            # 计算框的中心点
            center_x = (bx1 + bx2) / 2
            center_y = (by1 + by2) / 2
            
            # 判断中心点是否在ROI内
            if x1 <= center_x <= x2 and y1 <= center_y <= y2:
                count += 1
        
        return count
    
    def _annotate_with_roi(self, result, roi_coords):
        """绘制检测框：ROI内的框用红色，ROI外保持YOLO默认颜色。
        返回 (annotated_frame, inside_count)。"""
        annotated = result.plot()
        inside_count = 0

        if not (hasattr(result, 'boxes') and result.boxes is not None and len(result.boxes) > 0):
            return annotated, 0

        x1_roi, y1_roi, x2_roi, y2_roi = roi_coords

        for i in range(len(result.boxes)):
            box_n = result.boxes.xyxyn[i].cpu().numpy()
            cx = (float(box_n[0]) + float(box_n[2])) / 2
            cy = (float(box_n[1]) + float(box_n[3])) / 2

            if x1_roi <= cx <= x2_roi and y1_roi <= cy <= y2_roi:
                inside_count += 1
                box_px = result.boxes.xyxy[i].cpu().numpy()
                bx1, by1 = int(box_px[0]), int(box_px[1])
                bx2, by2 = int(box_px[2]), int(box_px[3])
                conf = float(result.boxes.conf[i].cpu().numpy())
                cls_id = int(result.boxes.cls[i].cpu().numpy())
                names = result.names if hasattr(result, 'names') and result.names else {}
                cls_name = names.get(cls_id, str(cls_id))
                label = f"{cls_name} {conf:.2f}"

                # 用较粗红框覆盖YOLO默认颜色
                cv2.rectangle(annotated, (bx1, by1), (bx2, by2), (0, 0, 255), 3)
                (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
                cv2.rectangle(annotated, (bx1, by1 - th - baseline - 2),
                              (bx1 + tw + 2, by1), (0, 0, 255), -1)
                cv2.putText(annotated, label, (bx1 + 1, by1 - baseline - 1),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

        return annotated, inside_count
    
    def _get_class_name(self, class_id):
        """获取类别名称"""
        if self.model and hasattr(self.model, 'names'):
            return self.model.names.get(class_id, f'Class {class_id}')
        return f'Class {class_id}'
