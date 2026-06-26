import { io, Socket } from "socket.io-client";
import { useAppStore } from "./store";

let socket: Socket | null = null;
let backendPort = 8080;

export function getSocket(): Socket | null {
  return socket;
}

export function initSocket(port: number = 8080, apiToken?: string): Socket {
  if (socket) {
    socket.disconnect();
  }

  backendPort = port;
  const url = `http://127.0.0.1:${port}`;

  socket = io(url, {
    transports: ["websocket"],
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    auth: apiToken ? { token: apiToken } : undefined,
    query: apiToken ? { token: apiToken } : undefined,
  });

  const store = useAppStore.getState();

  socket.on("connect", () => {
    store.setSocketConnected(true);
    store.addInferLog("已连接到推理服务");
  });

  socket.on("disconnect", () => {
    store.setSocketConnected(false);
    store.setInferring(false);
    store.setIsBatchInferring(false);
    store.setBatchProgress(null);
    store.addInferLog("与推理服务断开连接");
  });

  socket.on("inference_result", (data: {
    image?: string;
    detection_count?: number;
    message?: string;
  }) => {
    if (data.image) {
      // 后端 _image_to_base64 已包含 "data:image/jpeg;base64," 前缀
      store.setCurrentFrame(data.image);
    }
    store.setInferring(false);
    if (data.message) store.addInferLog(data.message);
  });

  socket.on("inference_progress", (data: {
    image?: string;
    frame?: number;
    fps?: number;
    detection_count?: number;
  }) => {
    // RTSP / 视频帧实时预览
    if (data.image) {
      store.setCurrentFrame(data.image);
    }
  });

  socket.on("inference_status", (data: { message?: string }) => {
    if (data.message) store.addInferLog(data.message);
  });

  socket.on("inference_complete", (data: { message?: string }) => {
    store.setInferring(false);
    if (data.message) store.addInferLog(data.message);
  });

  socket.on("inference_error", (data: { message?: string }) => {
    store.setInferring(false);
    store.setIsBatchInferring(false);
    store.setBatchProgress(null);
    if (data.message) store.addInferLog(`推理错误: ${data.message}`);
  });

  socket.on("inference_stopped", (data: { message?: string }) => {
    store.setInferring(false);
    store.setIsBatchInferring(false);
    store.setBatchProgress(null);
    if (data.message) store.addInferLog(data.message);
  });

  // 批量推理事件
  socket.on("batch_progress", (data: { current: number; total: number; filename?: string }) => {
    store.setBatchProgress(data);
  });

  socket.on("batch_item_result", (data: {
    index: number;
    total: number;
    filename: string;
    image: string;
    detection_count: number;
    error?: string;
  }) => {
    store.addBatchResult({
      id: `${data.index}-${Date.now()}`,
      filename: data.filename,
      image: data.image,
      detectionCount: data.detection_count,
      index: data.index,
      error: data.error,
    });
    store.setBatchProgress({ current: data.index + 1, total: data.total });
    store.addInferLog(`完成 (${data.index + 1}/${data.total}): ${data.filename} — ${data.error ?? `${data.detection_count} 个目标`}`);
  });

  socket.on("batch_complete", (data: { total: number; processed?: number; message?: string }) => {
    store.setInferring(false);
    store.setIsBatchInferring(false);
    store.setBatchProgress(null);
    if (data.message) store.addInferLog(data.message);
  });

  socket.on("alarm_triggered", (data: {
    filename?: string;
    count?: number;
    timestamp?: string;
    source_type?: string;
  }) => {
    if (data.filename) {
      store.addAlarmImage({
        id: Date.now().toString(),
        src: `http://127.0.0.1:${backendPort}/static/alarmimage/${data.filename}`,
        timestamp: data.timestamp ?? new Date().toLocaleTimeString(),
        label: `${data.source_type ?? "报警"} (${data.count ?? 0}个目标)`,
      });
    }
  });

  socket.on("system_info", (data: {
    has_gpu: boolean;
    gpu_name: string;
    cuda_version: string;
    cpu_info: string;
  }) => {
    store.setSystemInfo(data);
  });

  socket.on("connect_error", (err: Error) => {
    store.addInferLog(`连接错误: ${err.message}`);
  });

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function emitStartInference(params: Record<string, unknown>) {
  const store = useAppStore.getState();
  if (params.input_type === "images") {
    store.setInferring(true);  // 统一忙碌态，使按钮切换为"停止"
    store.setIsBatchInferring(true);
    store.clearBatchResults();
    store.setBatchProgress({ current: 0, total: (params.input_paths as string[]).length });
  } else {
    store.setInferring(true);
    store.setCurrentFrame(null);
  }
  socket?.emit("start_inference", params);
}

export function emitStopInference() {
  const store = useAppStore.getState();
  store.setInferring(false);
  store.setIsBatchInferring(false);
  store.setBatchProgress(null);
  socket?.emit("stop_inference");
}

export { backendPort };
