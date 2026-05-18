import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface AppConfig {
  mode: "conda";
  conda: {
    envPath: string;
    envName: string;
    pythonExe: string;
  };
  port: number;
  appDir: string; // easy_infer_station 目录的绝对路径
}

export interface AlarmImage {
  id: string;
  src: string; // base64 或 URL
  timestamp: string;
  label: string;
}

export interface SystemInfo {
  has_gpu: boolean;
  gpu_name: string;
  cuda_version: string;
  cpu_info: string;
}

export interface InferParams {
  model_path: string;
  confidence: number;
  iou: number;
  device: string;
  input_type: "image" | "video" | "rtsp";
  input_source: string;
  frame_skip: number;
  enable_roi: boolean;
  roi: [number, number, number, number] | null;
}

interface AppState {
  // 配置（持久化）
  config: AppConfig | null;
  isConfigured: boolean;

  // 后端状态
  backendStatus: "stopped" | "starting" | "running" | "error";
  backendMessage: string;

  // Socket.IO 连接
  socketConnected: boolean;

  // 系统信息
  systemInfo: SystemInfo | null;

  // 推理状态
  isInferring: boolean;
  currentFrame: string | null;
  inferLog: string[];

  // 模型列表和标签
  models: string[];
  labels: string[];

  // 报警图片
  alarmImages: AlarmImage[];

  // Actions
  setConfig: (config: AppConfig) => void;
  clearConfig: () => void;
  setBackendStatus: (
    status: "stopped" | "starting" | "running" | "error",
    message?: string
  ) => void;
  setSocketConnected: (connected: boolean) => void;
  setSystemInfo: (info: SystemInfo) => void;
  setInferring: (inferring: boolean) => void;
  setCurrentFrame: (frame: string | null) => void;
  addInferLog: (log: string) => void;
  clearInferLog: () => void;
  setModels: (models: string[]) => void;
  setLabels: (labels: string[]) => void;
  addAlarmImage: (img: AlarmImage) => void;
  clearAlarmImages: () => void;
  reset: () => void; // 清除配置，返回 SetupWizard
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      config: null,
      isConfigured: false,
      backendStatus: "stopped",
      backendMessage: "",
      socketConnected: false,
      systemInfo: null,
      isInferring: false,
      currentFrame: null,
      inferLog: [],
      models: [],
      labels: [],
      alarmImages: [],

      setConfig: (config) => set({ config, isConfigured: true }),
      clearConfig: () => set({ config: null, isConfigured: false }),
      setBackendStatus: (status, message = "") =>
        set({ backendStatus: status, backendMessage: message }),
      setSocketConnected: (connected) => set({ socketConnected: connected }),
      setSystemInfo: (info) => set({ systemInfo: info }),
      setInferring: (inferring) => set({ isInferring: inferring }),
      setCurrentFrame: (frame) => set({ currentFrame: frame }),
      addInferLog: (log) =>
        set((s) => ({
          inferLog: [...s.inferLog.slice(-199), `[${new Date().toLocaleTimeString()}] ${log}`],
        })),
      clearInferLog: () => set({ inferLog: [] }),
      setModels: (models) => set({ models }),
      setLabels: (labels) => set({ labels }),
      addAlarmImage: (img) =>
        set((s) => ({ alarmImages: [img, ...s.alarmImages].slice(0, 50) })),
      clearAlarmImages: () => set({ alarmImages: [] }),
      reset: () => set({ config: null, isConfigured: false }),
    }),
    {
      name: "easy-infer-station",
      partialize: (state) => ({
        config: state.config,
        isConfigured: state.isConfigured,
      }),
    }
  )
);
