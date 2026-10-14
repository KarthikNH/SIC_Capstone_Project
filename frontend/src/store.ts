import { create } from 'zustand';
import type {
  Bus,
  Branch,
  BusLayout,
  PredictResponse,
  ResultsResponse,
  GridStats,
  CascadeReplayResponse,
  GridListItem,
  UploadGridResponse,
  WhatIfResponse,
  TopologyData,
  GridMetadataResponse,
  DatasetCardResponse,
  GlobalInsightsResponse,
  MitigateResponse,
  ChatMessage,
  SuggestedFix,
  DatasetSplitsResponse,
  MaintenancePriorityResponse,
  PlannedOutageResponse,
  NotificationRule,
  NotificationSettings,
  OutboxEmail
} from './types';

// Single source of truth for backend API base URL
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

// Module-level abort controllers to cancel in-flight requests and avoid stale updates
let currentPredictController: AbortController | null = null;
let currentPredictKey = '';
let currentReplayController: AbortController | null = null;
let currentReplayKey = '';

// Default 24-hour typical load profile multiplier curve (60% to 120%)
export const DEFAULT_24H_LOAD_PROFILE = [
  0.68, 0.64, 0.61, 0.60, 0.63, 0.72,
  0.86, 0.98, 1.05, 1.08, 1.10, 1.12,
  1.14, 1.12, 1.10, 1.12, 1.18, 1.20,
  1.17, 1.12, 1.04, 0.94, 0.82, 0.73
];

interface GridState {
  gridCase: string;
  setGridCase: (c: string) => void;

  gridList: GridListItem[];
  loadingGridList: boolean;
  fetchGridList: () => Promise<void>;
  deleteGrid: (gridId: string) => Promise<void>;

  uploadModalOpen: boolean;
  setUploadModalOpen: (open: boolean) => void;
  uploadStatus: { loading: boolean; error: string | null; result: UploadGridResponse | null };
  setUploadStatus: (status: { loading: boolean; error: string | null; result: UploadGridResponse | null }) => void;
  uploadGrid: (file: File, name?: string) => Promise<UploadGridResponse>;

  buses: Bus[];
  branches: Branch[];
  layoutBuses: BusLayout[];
  layoutMap: Record<number, BusLayout>;
  layout2dMap: Record<number, BusLayout>;
  loadingGrid: boolean;
  gridError: string | null;
  failingUrl: string | null;

  gridStats: GridStats | null;
  loadingStats: boolean;

  outagedElements: string[];
  outageHistory: string[][];
  setOutagedElements: (elements: string[]) => void;
  toggleOutagedElement: (id: string, isShift?: boolean) => void;
  removeOutagedElement: (id: string) => void;
  clearOutages: () => void;
  undoOutage: () => void;

  loadScale: number;
  setLoadScale: (val: number) => void;

  prediction: PredictResponse | null;
  loadingPredict: boolean;
  predictError: string | null;

  whatifCurve: WhatIfResponse | null;
  loadingWhatif: boolean;
  fetchWhatifCurve: () => Promise<void>;

  resultsData: ResultsResponse | null;
  loadingResults: boolean;

  // Tabs state: Warning (default), Why, Stats, Data, Maintenance
  activeTab: 'warning' | 'why' | 'stats' | 'data' | 'maintenance';
  setActiveTab: (tab: 'warning' | 'why' | 'stats' | 'data' | 'maintenance') => void;

  // Maintenance Prioritisation & Planned Outage State
  maintenanceData: MaintenancePriorityResponse | null;
  loadingMaintenance: boolean;
  maintenanceError: string | null;
  maintenanceLoadProfile: number[];
  setMaintenanceLoadProfile: (profile: number[]) => void;
  selectedMaintenanceAsset: string | null;
  setSelectedMaintenanceAsset: (id: string | null) => void;
  plannedOutageResult: PlannedOutageResponse | null;
  loadingPlannedOutage: boolean;
  plannedOutageError: string | null;
  showMaintenanceOverlay: boolean;
  toggleMaintenanceOverlay: () => void;
  fetchMaintenancePriorities: (customProfile?: number[]) => Promise<void>;
  evaluatePlannedOutage: (assetId: string, customProfile?: number[]) => Promise<void>;
  uploadAssetCsv: (file: File) => Promise<{ status: string; count?: number; message?: string }>;

  // Notifications Drawer & Outbox State
  notificationsOpen: boolean;
  setNotificationsOpen: (open: boolean) => void;
  toggleNotifications: () => void;
  notificationSettings: NotificationSettings | null;
  notificationRules: NotificationRule[];
  outboxEmails: OutboxEmail[];
  notificationHistory: any[];
  loadingNotifications: boolean;
  fetchNotificationSettings: () => Promise<void>;
  fetchNotificationRules: () => Promise<void>;
  createNotificationRule: (rule: Partial<NotificationRule>) => Promise<any>;
  deleteNotificationRule: (id: string) => Promise<void>;
  updateNotificationSettings: (settings: Partial<NotificationSettings>) => Promise<void>;
  sendTestNotificationEmail: (recipient: string) => Promise<any>;
  sendDigestNotificationEmail: (gridId?: string) => Promise<any>;
  runNotificationCheckNow: () => Promise<any>;
  fetchOutboxEmails: () => Promise<void>;
  fetchNotificationHistory: () => Promise<void>;

  // View Mode: 3D vs Map vs City
  viewMode: '3d' | 'map' | 'city';
  setViewMode: (mode: '3d' | 'map' | 'city') => void;

  // Visual Controls: Labels, Buildings Opacity, Voltage Grouping
  labelMode: 'smart' | 'all' | 'off';
  setLabelMode: (mode: 'smart' | 'all' | 'off') => void;
  buildingsOpacity: number;
  setBuildingsOpacity: (val: number) => void;
  applyToStructures: boolean;
  setApplyToStructures: (val: boolean) => void;
  groupByVoltage: boolean;
  setGroupByVoltage: (val: boolean) => void;

  // Topology Overlay state (Map mode)
  topologyOverlay: 'none' | 'degree' | 'betweenness' | 'community' | 'bridges';
  setTopologyOverlay: (overlay: 'none' | 'degree' | 'betweenness' | 'community' | 'bridges') => void;
  topologyData: TopologyData | null;
  loadingTopology: boolean;
  fetchTopology: () => Promise<void>;

  // Dataset Card & Inspector state (Data tab)
  datasetCard: DatasetCardResponse | null;
  loadingDatasetCard: boolean;
  datasetCardError: string | null;
  datasetCardFailingUrl: string | null;
  fetchDatasetCard: () => Promise<void>;

  // Global Insights state (Model Insights collapsible)
  globalInsights: GlobalInsightsResponse | null;
  loadingGlobalInsights: boolean;
  fetchGlobalInsights: () => Promise<void>;

  // Grid Metadata state (Uploaded vs Training)
  gridMetadata: GridMetadataResponse | null;
  loadingGridMetadata: boolean;
  fetchGridMetadata: (id?: string) => Promise<void>;

  // Chat Assistant Drawer state
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  toggleChat: () => void;
  chatMessages: ChatMessage[];
  chatStreaming: boolean;
  isOfflineChat: boolean;
  chatActionNotification: string | null;
  setChatActionNotification: (msg: string | null) => void;
  sendChatMessage: (content: string) => Promise<void>;
  resetChat: () => void;
  verifyMitigation: (actionId: string) => Promise<void>;

  // Criticality Map state
  showCriticality: boolean;
  loadingCriticality: boolean;
  criticalityProgress: number;
  criticalityData: any | null;
  branchCriticalityMap: Record<number, number>;
  toggleCriticality: () => void;

  // Influential branches 3D glow toggle
  glowInfluential: boolean;
  toggleGlowInfluential: () => void;

  // View & visualization toggles
  showBusNumbers: boolean;
  setShowBusNumbers: (val: boolean) => void;
  toggleShowBusNumbers: () => void;

  cameraResetTrigger: number;
  triggerCameraReset: () => void;

  // Cascade Replay State
  replayData: CascadeReplayResponse | null;
  replayStepIndex: number;
  isPlayingReplay: boolean;
  loadingReplay: boolean;
  replayError: string | null;
  replaySpeed: number;
  setReplaySpeed: (speed: number) => void;
  stepForwardReplay: () => void;
  stepBackReplay: () => void;
  restartReplay: () => void;
  startCascadeReplay: () => Promise<void>;
  stopCascadeReplay: () => void;
  setReplayStepIndex: (step: number) => void;
  togglePlayPauseReplay: () => void;

  fetchGridAndLayout: () => Promise<void>;
  fetchGridStats: () => Promise<void>;
  fetchPrediction: () => Promise<void>;
  fetchResults: () => Promise<void>;

  // Suggested Fix & Counterfactuals
  suggestedFix: SuggestedFix | null;
  loadingSuggestedFix: boolean;
  appliedFix: SuggestedFix | null;
  verifiedFixResult: { before: string; after: string; contained: boolean } | null;
  modifications: Record<string, any> | null;
  previousStateBeforeFix: { loadScale: number; modifications: Record<string, any> | null; replayData?: CascadeReplayResponse | null } | null;
  fetchSuggestedFix: () => Promise<void>;
  applyFix: (fix: SuggestedFix) => Promise<void>;
  undoFix: () => Promise<void>;
  verifyFixInSimulator: () => Promise<void>;

  // Dataset Splits (Data tab)
  datasetSplits: DatasetSplitsResponse | null;
  loadingDatasetSplits: boolean;
  fetchDatasetSplits: () => Promise<void>;
}

export const useGridStore = create<GridState>((set, get) => ({
  gridCase: 'case30',
  setGridCase: (c) => {
    // Abort in-flight requests on grid switch
    if (currentPredictController) {
      currentPredictController.abort();
      currentPredictController = null;
    }
    if (currentReplayController) {
      currentReplayController.abort();
      currentReplayController = null;
    }
    currentPredictKey = '';
    currentReplayKey = '';

    set((state) => ({
      gridCase: c,
      outagedElements: ['line_0'],
      outageHistory: [],
      prediction: null,
      predictError: null,
      loadingPredict: false,
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false,
      loadingReplay: false,
      replayError: null,
      suggestedFix: null,
      loadingSuggestedFix: false,
      appliedFix: null,
      verifiedFixResult: null,
      modifications: null,
      previousStateBeforeFix: null,
      showCriticality: false,
      criticalityData: null,
      branchCriticalityMap: {},
      topologyData: null,
      gridMetadata: null,
      cameraResetTrigger: state.cameraResetTrigger + 1
    }));
    get().fetchGridAndLayout();
    get().fetchGridStats();
    get().fetchTopology();
    get().fetchGridMetadata(c);
    get().fetchPrediction();
  },

  gridList: [],
  loadingGridList: false,
  fetchGridList: async () => {
    set({ loadingGridList: true });
    try {
      const res = await fetch(`${API_BASE}/grids`);
      if (res.ok) {
        const list: GridListItem[] = await res.json();
        set({ gridList: list, loadingGridList: false });
      } else {
        set({
          loadingGridList: false,
          gridError: 'Could not load grid data. Is the backend running?',
          failingUrl: `${API_BASE}/grids`
        });
      }
    } catch (err: any) {
      console.error('Failed to list grids:', err);
      set({
        loadingGridList: false,
        gridError: 'Could not load grid data. Is the backend running?',
        failingUrl: `${API_BASE}/grids`
      });
    }
  },

  deleteGrid: async (gridId: string) => {
    try {
      const res = await fetch(`${API_BASE}/grids/${gridId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        await get().fetchGridList();
        if (get().gridCase === gridId) {
          get().setGridCase('case30');
        }
      }
    } catch (err) {
      console.error('Failed to delete grid:', err);
    }
  },

  uploadModalOpen: false,
  setUploadModalOpen: (open) => set({ uploadModalOpen: open }),
  uploadStatus: { loading: false, error: null, result: null },
  setUploadStatus: (status) => set({ uploadStatus: status }),
  uploadGrid: async (file: File, name?: string) => {
    set({ uploadStatus: { loading: true, error: null, result: null } });
    try {
      const formData = new FormData();
      formData.append('files', file);
      const url = name
        ? `${API_BASE}/grids/upload?grid_name=${encodeURIComponent(name)}`
        : `${API_BASE}/grids/upload`;
      const res = await fetch(url, {
        method: 'POST',
        body: formData
      });
      const data: UploadGridResponse = await res.json();
      if (!res.ok) {
        const errMsg =
          (data.report && data.report.errors && data.report.errors.join('. ')) ||
          (data as any).detail ||
          'Upload validation failed';
        set({ uploadStatus: { loading: false, error: errMsg, result: data } });
        return data;
      }
      set({ uploadStatus: { loading: false, error: null, result: data } });
      await get().fetchGridList();
      return data;
    } catch (err: any) {
      set({ uploadStatus: { loading: false, error: err.message || 'Upload error', result: null } });
      throw err;
    }
  },

  buses: [],
  branches: [],
  layoutBuses: [],
  layoutMap: {},
  layout2dMap: {},
  loadingGrid: true,
  gridError: null,
  failingUrl: null,

  gridStats: null,
  loadingStats: false,

  outagedElements: ['line_3'],
  outageHistory: [],

  setOutagedElements: (elements) => {
    const current = get().outagedElements;
    set((state) => ({
      outageHistory: [...state.outageHistory, current],
      outagedElements: elements,
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false
    }));
    get().fetchPrediction();
  },

  toggleOutagedElement: (id, isShift = false) => {
    const current = get().outagedElements;
    const history = [...get().outageHistory, current];
    let updated: string[];

    if (current.includes(id)) {
      updated = current.filter((x) => x !== id);
    } else {
      if (isShift) {
        if (current.length >= 2) {
          updated = [current[1], id];
        } else {
          updated = [...current, id];
        }
      } else {
        updated = [id];
      }
    }

    set({
      outageHistory: history,
      outagedElements: updated,
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false
    });
    get().fetchPrediction();
  },

  removeOutagedElement: (id) => {
    const current = get().outagedElements;
    const history = [...get().outageHistory, current];
    const updated = current.filter((x) => x !== id);
    set({
      outageHistory: history,
      outagedElements: updated,
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false
    });
    get().fetchPrediction();
  },

  clearOutages: () => {
    const current = get().outagedElements;
    set((state) => ({
      outageHistory: [...state.outageHistory, current],
      outagedElements: [],
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false
    }));
    get().fetchPrediction();
  },

  undoOutage: () => {
    const history = get().outageHistory;
    if (history.length === 0) return;
    const previous = history[history.length - 1];
    set({
      outagedElements: previous,
      outageHistory: history.slice(0, -1),
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false
    });
    get().fetchPrediction();
  },

  loadScale: 1.0,
  setLoadScale: (val) => {
    if (currentReplayController) {
      currentReplayController.abort();
      currentReplayController = null;
    }
    currentReplayKey = '';
    set({
      loadScale: val,
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false,
      verifiedFixResult: null
    });
    get().fetchPrediction();
  },

  prediction: null,
  loadingPredict: false,
  predictError: null,

  whatifCurve: null,
  loadingWhatif: false,
  fetchWhatifCurve: async () => {
    const { gridCase, outagedElements } = get();
    set({ loadingWhatif: true });
    try {
      const res = await fetch(`${API_BASE}/whatif-curve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          outaged: outagedElements.length > 0 ? outagedElements : ['line_0'],
          min_load: 0.6,
          max_load: 1.2,
          step: 0.05
        })
      });
      if (res.ok) {
        const data = await res.json();
        set({ whatifCurve: data, loadingWhatif: false });
      } else {
        set({ loadingWhatif: false });
      }
    } catch {
      set({ loadingWhatif: false });
    }
  },

  resultsData: null,
  loadingResults: false,

  activeTab: 'warning',
  setActiveTab: (tab) => set({ activeTab: tab }),

  // View Mode: 3D vs Map vs City
  viewMode: (typeof window !== 'undefined' && (localStorage.getItem('sic_view_mode') as '3d' | 'map' | 'city')) || '3d',
  setViewMode: (mode) => {
    try {
      localStorage.setItem('sic_view_mode', mode);
    } catch {}
    set({ viewMode: mode });
  },

  labelMode: (typeof window !== 'undefined' && (localStorage.getItem('sic_label_mode') as 'smart' | 'all' | 'off')) || 'smart',
  setLabelMode: (mode) => {
    try {
      localStorage.setItem('sic_label_mode', mode);
    } catch {}
    set({ labelMode: mode });
  },

  buildingsOpacity: typeof window !== 'undefined' && localStorage.getItem('sic_buildings_opacity') !== null
    ? Math.max(0, Math.min(100, Number(localStorage.getItem('sic_buildings_opacity'))))
    : 100,
  setBuildingsOpacity: (val) => {
    try {
      localStorage.setItem('sic_buildings_opacity', String(val));
    } catch {}
    set({ buildingsOpacity: val });
  },

  applyToStructures: typeof window !== 'undefined' && localStorage.getItem('sic_structures_opacity') !== null
    ? localStorage.getItem('sic_structures_opacity') === 'true'
    : false,
  setApplyToStructures: (val) => {
    try {
      localStorage.setItem('sic_structures_opacity', String(val));
    } catch {}
    set({ applyToStructures: val });
  },

  groupByVoltage: false,
  setGroupByVoltage: (val) => set({ groupByVoltage: val }),

  // Topology Overlay state (Map mode)
  topologyOverlay: 'none',
  setTopologyOverlay: (overlay) => set({ topologyOverlay: overlay }),
  topologyData: null,
  loadingTopology: false,
  fetchTopology: async () => {
    const { gridCase } = get();
    set({ loadingTopology: true });
    try {
      const res = await fetch(`${API_BASE}/grids/${gridCase}/topology`);
      if (res.ok) {
        const data: TopologyData = await res.json();
        set({ topologyData: data, loadingTopology: false });
      } else {
        set({ loadingTopology: false });
      }
    } catch {
      set({ loadingTopology: false });
    }
  },

  // Dataset Card & Inspector state
  datasetCard: null,
  loadingDatasetCard: false,
  datasetCardError: null,
  datasetCardFailingUrl: null,
  fetchDatasetCard: async () => {
    set({ loadingDatasetCard: true, datasetCardError: null, datasetCardFailingUrl: null });
    try {
      const res = await fetch(`${API_BASE}/dataset/card`);
      if (res.ok) {
        const data: DatasetCardResponse = await res.json();
        set({ datasetCard: data, loadingDatasetCard: false, datasetCardError: null, datasetCardFailingUrl: null });
      } else {
        set({
          loadingDatasetCard: false,
          datasetCardError: `Server responded with status ${res.status}`,
          datasetCardFailingUrl: `${API_BASE}/dataset/card`
        });
      }
    } catch (err: any) {
      set({
        loadingDatasetCard: false,
        datasetCardError: err.message || 'Network request failed',
        datasetCardFailingUrl: `${API_BASE}/dataset/card`
      });
    }
  },

  // Global Insights state
  globalInsights: null,
  loadingGlobalInsights: false,
  fetchGlobalInsights: async () => {
    set({ loadingGlobalInsights: true });
    try {
      const res = await fetch(`${API_BASE}/insights/global`);
      if (res.ok) {
        const data: GlobalInsightsResponse = await res.json();
        set({ globalInsights: data, loadingGlobalInsights: false });
      } else {
        set({ loadingGlobalInsights: false });
      }
    } catch {
      set({ loadingGlobalInsights: false });
    }
  },

  // Grid Metadata state
  gridMetadata: null,
  loadingGridMetadata: false,
  fetchGridMetadata: async (id) => {
    const targetId = id || get().gridCase;
    set({ loadingGridMetadata: true });
    try {
      const res = await fetch(`${API_BASE}/grids/${targetId}/metadata`);
      if (res.ok) {
        const data: GridMetadataResponse = await res.json();
        set({ gridMetadata: data, loadingGridMetadata: false });
      } else {
        set({ loadingGridMetadata: false });
      }
    } catch {
      set({ loadingGridMetadata: false });
    }
  },

  // Chat Assistant Drawer state
  chatOpen: false,
  setChatOpen: (open) => set({ chatOpen: open }),
  toggleChat: () => set((state) => ({ chatOpen: !state.chatOpen })),
  chatMessages: [
    {
      id: 'welcome-1',
      role: 'assistant',
      content: 'Welcome to Gridwatch Assistant. I am your early-warning power grid co-pilot. Ask me to diagnose contingency risks, suggest mitigation actions, inspect topology, or review training data.',
      timestamp: Date.now()
    }
  ],
  chatStreaming: false,
  isOfflineChat: false,
  chatActionNotification: null,
  setChatActionNotification: (msg) => set({ chatActionNotification: msg }),
  resetChat: () =>
    set({
      chatMessages: [
        {
          id: `welcome-${Date.now()}`,
          role: 'assistant',
          content: 'Conversation reset. Ready to assist with transmission security analysis.',
          timestamp: Date.now()
        }
      ],
      chatStreaming: false,
      chatActionNotification: null
    }),

  sendChatMessage: async (content: string) => {
    const { gridCase, outagedElements, loadScale, chatMessages } = get();
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: Date.now()
    };
    const assistantId = `assistant-${Date.now()}`;
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
      toolResults: [],
      actions: [],
      mitigationActions: []
    };

    set({
      chatMessages: [...chatMessages, userMsg, assistantMsg],
      chatStreaming: true
    });

    try {
      const history = [...chatMessages, userMsg].map((m) => ({
        role: m.role,
        content: m.content
      }));

      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          context: {
            grid_id: gridCase,
            outaged: outagedElements,
            load_scale: loadScale
          }
        })
      });

      if (!res.ok) {
        throw new Error(`Chat request failed with ${res.status}`);
      }

      if (res.headers.get('x-chat-mode') === 'offline') {
        set({ isOfflineChat: true });
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No readable response stream');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            set((state) => {
              const updatedMessages = state.chatMessages.map((msg) => {
                if (msg.id !== assistantId) return msg;

                if (parsed.type === 'token') {
                  return { ...msg, content: msg.content + (parsed.content || '') };
                }
                if (parsed.type === 'tool_call') {
                  return {
                    ...msg,
                    toolCalls: [...(msg.toolCalls || []), { name: parsed.name, args: parsed.args }]
                  };
                }
                if (parsed.type === 'tool_result') {
                  const mActions =
                    parsed.name === 'suggest_mitigation' && parsed.data?.top_recommendations
                      ? parsed.data.top_recommendations
                      : msg.mitigationActions;
                  return {
                    ...msg,
                    toolResults: [...(msg.toolResults || []), { name: parsed.name, data: parsed.data }],
                    mitigationActions: mActions
                  };
                }
                if (parsed.type === 'action') {
                  // Execute UI action
                  if (parsed.action === 'set_load' && typeof parsed.value === 'number') {
                    get().setLoadScale(parsed.value);
                  } else if (parsed.action === 'select_outage' && parsed.value) {
                    get().setOutagedElements([parsed.value]);
                  } else if (parsed.action === 'show_criticality') {
                    if (!get().showCriticality) get().toggleCriticality();
                  } else if (parsed.action === 'switch_tab' && parsed.value) {
                    get().setActiveTab(parsed.value);
                  }
                  return {
                    ...msg,
                    actions: [...(msg.actions || []), parsed]
                  };
                }
                if (parsed.type === 'done') {
                  return { ...msg, isStreaming: false };
                }
                return msg;
              });

              let isOffline = state.isOfflineChat;
              if (parsed.type === 'done' && parsed.offline !== undefined) {
                isOffline = !!parsed.offline;
              }

              let notification = state.chatActionNotification;
              if (parsed.type === 'action' && parsed.description) {
                notification = parsed.description;
              }

              return {
                chatMessages: updatedMessages,
                isOfflineChat: isOffline,
                chatActionNotification: notification
              };
            });
          } catch {
            // Ignore non-json lines
          }
        }
      }

      set((state) => ({
        chatStreaming: false,
        chatMessages: state.chatMessages.map((m) =>
          m.id === assistantId ? { ...m, isStreaming: false } : m
        )
      }));
    } catch (err: any) {
      console.error('Chat error:', err);
      set((state) => ({
        chatStreaming: false,
        chatMessages: state.chatMessages.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: m.content || `Error connecting to assistant: ${err.message}`,
                isStreaming: false
              }
            : m
        )
      }));
    }
  },

  verifyMitigation: async (actionId: string) => {
    const { gridCase, outagedElements, loadScale } = get();
    try {
      const res = await fetch(`${API_BASE}/mitigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid_id: gridCase,
          outaged: outagedElements,
          load_scale: loadScale,
          verify: true
        })
      });
      if (res.ok) {
        const data: MitigateResponse = await res.json();
        const updatedAction = data.actions.find((a) => a.id === actionId) || data.actions[0];
        set((state) => ({
          chatMessages: state.chatMessages.map((msg) => ({
            ...msg,
            mitigationActions: msg.mitigationActions?.map((act) =>
              act.id === actionId || act.title === updatedAction.title ? updatedAction : act
            )
          }))
        }));
      }
    } catch (err) {
      console.error('Failed to verify mitigation:', err);
    }
  },

  // Criticality Map state
  showCriticality: false,
  loadingCriticality: false,
  criticalityProgress: 0,
  criticalityData: null,
  branchCriticalityMap: {},
  toggleCriticality: async () => {
    const currentShow = get().showCriticality;
    if (currentShow) {
      set({ showCriticality: false });
      return;
    }

    if (get().criticalityData && get().criticalityData.grid_id === get().gridCase) {
      set({ showCriticality: true });
      return;
    }

    const { gridCase, loadScale } = get();
    set({ loadingCriticality: true, criticalityProgress: 0.1 });
    try {
      const res = await fetch(`${API_BASE}/criticality-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          load_scale: loadScale
        })
      });
      if (!res.ok) throw new Error('Criticality request failed');
      const startData = await res.json();

      if (startData.status === 'completed' && startData.result) {
        const resObj = startData.result;
        const bMap: Record<number, number> = {};
        (resObj.all_elements_screened || []).forEach((el: any) => {
          if (el.element_id && el.element_id.startsWith('line_')) {
            const bId = parseInt(el.element_id.replace('line_', ''), 10);
            bMap[bId] = el.cascade_probability;
          }
        });
        set({
          criticalityData: resObj,
          branchCriticalityMap: bMap,
          loadingCriticality: false,
          criticalityProgress: 1.0,
          showCriticality: true
        });
        return;
      }

      const taskId = startData.task_id;
      let attempts = 0;
      const poll = async () => {
        attempts++;
        try {
          const pollRes = await fetch(`${API_BASE}/criticality-map/${taskId}`);
          if (pollRes.ok) {
            const task = await pollRes.json();
            set({ criticalityProgress: task.progress || 0.4 });
            if (task.status === 'completed' && task.result) {
              const resObj = task.result;
              const bMap: Record<number, number> = {};
              (resObj.all_elements_screened || []).forEach((el: any) => {
                if (el.element_id && el.element_id.startsWith('line_')) {
                  const bId = parseInt(el.element_id.replace('line_', ''), 10);
                  bMap[bId] = el.cascade_probability;
                }
              });
              set({
                criticalityData: resObj,
                branchCriticalityMap: bMap,
                loadingCriticality: false,
                criticalityProgress: 1.0,
                showCriticality: true
              });
              return;
            }
          }
        } catch {
          // ignore transient poll error
        }

        if (attempts < 30) {
          setTimeout(poll, 450);
        } else {
          set({ loadingCriticality: false });
        }
      };
      poll();
    } catch (err) {
      console.error('Criticality screening error:', err);
      set({ loadingCriticality: false });
    }
  },

  glowInfluential: false,
  toggleGlowInfluential: () => set((state) => ({ glowInfluential: !state.glowInfluential })),

  showBusNumbers: false,
  setShowBusNumbers: (val) => set({ showBusNumbers: val }),
  toggleShowBusNumbers: () => set((state) => ({ showBusNumbers: !state.showBusNumbers })),

  cameraResetTrigger: 0,
  triggerCameraReset: () => set((state) => ({ cameraResetTrigger: state.cameraResetTrigger + 1 })),

  // Cascade Replay State
  replayData: null,
  replayStepIndex: -1,
  isPlayingReplay: false,
  loadingReplay: false,
  replayError: null,
  replaySpeed: 1,
  setReplaySpeed: (speed) => set({ replaySpeed: speed }),
  stepForwardReplay: () => {
    const { replayData, replayStepIndex } = get();
    if (replayData && replayStepIndex < replayData.total_steps - 1) {
      set({ replayStepIndex: replayStepIndex + 1 });
    }
  },
  stepBackReplay: () => {
    const { replayStepIndex } = get();
    if (replayStepIndex > 0) {
      set({ replayStepIndex: replayStepIndex - 1 });
    }
  },
  restartReplay: () => {
    set({ replayStepIndex: 0, isPlayingReplay: false });
  },

  startCascadeReplay: async () => {
    const { gridCase, outagedElements, loadScale, modifications } = get();
    const sortedOutages = [...outagedElements].sort();
    const modStr = modifications ? JSON.stringify(modifications) : '';
    const requestKey = `${gridCase}::${sortedOutages.join(',')}::${loadScale}::${modStr}`;

    // Cancel in-flight replay
    if (currentReplayController) {
      currentReplayController.abort();
    }
    currentReplayController = new AbortController();
    currentReplayKey = requestKey;

    set({ loadingReplay: true, replayError: null, isPlayingReplay: true });
    try {
      const res = await fetch(`${API_BASE}/cascade-replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: currentReplayController.signal,
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          outaged: sortedOutages.length > 0 ? sortedOutages : ['line_0'],
          load_scale: loadScale,
          modifications: modifications || undefined
        })
      });

      // Ignore stale response if key changed
      if (currentReplayKey !== requestKey) {
        return;
      }

      if (!res.ok) throw new Error(`Replay server error ${res.status}`);
      const data: CascadeReplayResponse = await res.json();
      set({
        replayData: data,
        replayStepIndex: 0,
        isPlayingReplay: true,
        loadingReplay: false
      });

      // Refresh suggested fix to evaluate simulator disagreement if needed
      get().fetchSuggestedFix();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return;
      }
      if (currentReplayKey === requestKey) {
        console.error('Failed to simulate cascade replay:', err);
        set({
          replayError: err.message || 'Simulation replay failed',
          loadingReplay: false,
          isPlayingReplay: false
        });
      }
    }
  },

  stopCascadeReplay: () => {
    set({
      isPlayingReplay: false,
      replayStepIndex: -1,
      replayData: null
    });
  },

  setReplayStepIndex: (step) => {
    set({ replayStepIndex: step });
  },

  togglePlayPauseReplay: () => {
    set((state) => ({ isPlayingReplay: !state.isPlayingReplay }));
  },

  fetchGridAndLayout: async () => {
    const c = get().gridCase;
    set({ loadingGrid: true, gridError: null, failingUrl: null });
    const gridUrl = `${API_BASE}/grid?case=${c}`;
    const layoutUrl = `${API_BASE}/layout?case=${c}`;

    let currentUrl = gridUrl;
    try {
      currentUrl = gridUrl;
      const gridRes = await fetch(gridUrl);
      if (!gridRes.ok) {
        throw new Error(`HTTP ${gridRes.status} on ${gridUrl}`);
      }
      const gridData = await gridRes.json();

      currentUrl = layoutUrl;
      const layoutRes = await fetch(layoutUrl);
      if (!layoutRes.ok) {
        throw new Error(`HTTP ${layoutRes.status} on ${layoutUrl}`);
      }
      const layoutData = await layoutRes.json();

      const lMap: Record<number, BusLayout> = {};
      if (layoutData.buses) {
        layoutData.buses.forEach((b: BusLayout) => {
          lMap[b.bus_id] = b;
        });
      }

      // Fetch 2D topological layout for Map mode
      let l2dMap: Record<number, BusLayout> = {};
      try {
        const layout2dRes = await fetch(`${API_BASE}/layout2d?case=${c}`);
        if (layout2dRes.ok) {
          const layout2dData = await layout2dRes.json();
          if (layout2dData.buses) {
            layout2dData.buses.forEach((b: any) => {
              const bId = b.bus_id !== undefined ? b.bus_id : b.id;
              l2dMap[bId] = {
                bus_id: bId,
                x: b.x,
                y: b.y ?? 0,
                z: b.z,
                vn_kv: b.vn_kv ?? 132,
                type: b.type ?? 'substation',
                degree: b.degree ?? 2
              };
            });
          }
        }
      } catch (e) {
        console.warn('Failed to load 2D layout, falling back to 3D projection:', e);
      }

      set({
        buses: gridData.buses || [],
        branches: gridData.branches || [],
        layoutBuses: layoutData.buses || [],
        layoutMap: lMap,
        layout2dMap: l2dMap,
        loadingGrid: false,
        gridError: null,
        failingUrl: null
      });

      get().fetchPrediction();
    } catch (err: any) {
      console.error('Failed to load grid topology or layout:', err);
      const urlText = err.message && err.message.includes('on ') ? err.message.split('on ')[1] : currentUrl;
      set({
        gridError: 'Could not load grid data. Is the backend running?',
        failingUrl: urlText,
        loadingGrid: false
      });
    }
  },

  fetchGridStats: async () => {
    const c = get().gridCase;
    set({ loadingStats: true });
    try {
      const res = await fetch(`${API_BASE}/grids/${c}/stats`);
      if (res.ok) {
        const stats: GridStats = await res.json();
        set({ gridStats: stats, loadingStats: false });
      } else {
        set({ loadingStats: false });
      }
    } catch (err) {
      console.error('Failed to fetch grid statistics:', err);
      set({ loadingStats: false });
    }
  },

  fetchPrediction: async () => {
    const { gridCase, outagedElements, loadScale, modifications } = get();
    const sortedOutages = [...outagedElements].sort();
    const modStr = modifications ? JSON.stringify(modifications) : '';
    const requestKey = `${gridCase}::${sortedOutages.join(',')}::${loadScale}::${modStr}`;

    // Cancel in-flight predict request if key changed or new request starts
    if (currentPredictController) {
      currentPredictController.abort();
    }
    currentPredictController = new AbortController();
    currentPredictKey = requestKey;

    set({ loadingPredict: true, predictError: null });

    try {
      const res = await fetch(`${API_BASE}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: currentPredictController.signal,
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          outaged: sortedOutages.length > 0 ? sortedOutages : ['line_0'],
          load_scale: loadScale,
          modifications: modifications || undefined
        })
      });

      // Ignore stale response if requestKey no longer matches
      if (currentPredictKey !== requestKey) {
        return;
      }

      if (!res.ok) {
        throw new Error(`Server responded with ${res.status}`);
      }
      const data: PredictResponse = await res.json();
      set({ prediction: data, loadingPredict: false });

      // Fetch suggested fix alongside
      get().fetchSuggestedFix();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return;
      }
      if (currentPredictKey === requestKey) {
        console.error('Prediction failed:', err);
        set({ predictError: err.message || 'Prediction failed', loadingPredict: false });
      }
    }

    // Refresh what-if curve alongside
    get().fetchWhatifCurve();
  },

  // Suggested Fix & Counterfactual workflow
  suggestedFix: null,
  loadingSuggestedFix: false,
  appliedFix: null,
  verifiedFixResult: null,
  modifications: null,
  previousStateBeforeFix: null,

  fetchSuggestedFix: async () => {
    const { gridCase, outagedElements, loadScale, prediction, replayData, modifications } = get();
    set({ loadingSuggestedFix: true });
    try {
      const currentProb = prediction?.probability ?? prediction?.cascade_probability ?? null;
      const actualCascade = replayData?.actual_cascade ?? (replayData ? Boolean(replayData.cascade) : null);
      const res = await fetch(`${API_BASE}/suggest-fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          outaged: outagedElements.length > 0 ? outagedElements : ['line_0'],
          load_scale: loadScale,
          current_probability: currentProb,
          actual_cascade: actualCascade,
          modifications: modifications || undefined
        })
      });
      if (res.ok) {
        const fix: SuggestedFix = await res.json();
        set({ suggestedFix: fix, loadingSuggestedFix: false });
      } else {
        set({ loadingSuggestedFix: false });
      }
    } catch (err) {
      console.error('Failed to fetch suggested fix:', err);
      set({ loadingSuggestedFix: false });
    }
  },

  applyFix: async (fix: SuggestedFix) => {
    const { loadScale, modifications, replayData } = get();
    // Cancel any in-flight requests
    if (currentPredictController) {
      currentPredictController.abort();
      currentPredictController = null;
    }
    if (currentReplayController) {
      currentReplayController.abort();
      currentReplayController = null;
    }

    // Save previous state including previous replayData for dynamic before description
    set({
      previousStateBeforeFix: { loadScale, modifications, replayData },
      appliedFix: fix,
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false,
      verifiedFixResult: null
    });

    if (fix.action?.type === 'load_scale' && typeof fix.action.target_value === 'number') {
      set({ loadScale: fix.action.target_value });
      if (fix.action.modifications) {
        set({ modifications: fix.action.modifications });
      }
    } else if (fix.action?.type === 'modifications' && fix.action.modifications) {
      set({ modifications: fix.action.modifications });
    }

    // Re-run predict with updated scene & risk
    await get().fetchPrediction();
  },

  undoFix: async () => {
    const { previousStateBeforeFix } = get();
    if (previousStateBeforeFix) {
      if (currentPredictController) {
        currentPredictController.abort();
        currentPredictController = null;
      }
      if (currentReplayController) {
        currentReplayController.abort();
        currentReplayController = null;
      }
      set({
        loadScale: previousStateBeforeFix.loadScale,
        modifications: previousStateBeforeFix.modifications,
        replayData: previousStateBeforeFix.replayData || null,
        replayStepIndex: previousStateBeforeFix.replayData ? 0 : -1,
        appliedFix: null,
        verifiedFixResult: null,
        previousStateBeforeFix: null
      });
      await get().fetchPrediction();
    }
  },

  verifyFixInSimulator: async () => {
    const { gridCase, outagedElements, loadScale, modifications, appliedFix, previousStateBeforeFix } = get();
    set({ loadingReplay: true });
    try {
      const res = await fetch(`${API_BASE}/cascade-replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          outaged: outagedElements.length > 0 ? outagedElements : ['line_0'],
          load_scale: loadScale,
          modifications: modifications || undefined
        })
      });
      if (res.ok) {
        const replay: CascadeReplayResponse = await res.json();
        const isContained = !replay.actual_cascade;
        const extraTrips = replay.additional_trips;
        const loadShedPct = (replay.final_load_shed_fraction * 100).toFixed(1);

        // Accurate before description based on pre-fix state
        const prevReplay = previousStateBeforeFix?.replayData;
        let beforeDesc = 'Before: cascade propagation observed';
        if (prevReplay) {
          const prevTrips = prevReplay.additional_trips;
          const prevShed = (prevReplay.final_load_shed_fraction * 100).toFixed(1);
          if (prevReplay.actual_cascade || prevReplay.cascade === 1) {
            beforeDesc = `Before: cascade, ${prevTrips} lines tripped, ${prevShed}% load shed.`;
          } else {
            beforeDesc = `Before: contained (${prevTrips} lines tripped, ${prevShed}% load shed).`;
          }
        } else if (appliedFix?.before_numbers) {
          if (appliedFix.before_numbers.status === 'cascade' || appliedFix.before_numbers.cascade) {
            const bTrips = (appliedFix.before_numbers as any).extra_trips ?? 2;
            const bShed = (appliedFix.before_numbers as any).load_shed_pct ?? 15.9;
            beforeDesc = `Before: cascade, ${bTrips} lines tripped, ${bShed}% load shed.`;
          } else if (typeof appliedFix.before_numbers.risk === 'number') {
            beforeDesc = `Before: high risk (${(appliedFix.before_numbers.risk * 100).toFixed(1)}%).`;
          }
        }

        const afterDesc = isContained
          ? (extraTrips === 0 && parseFloat(loadShedPct) === 0 ? 'After: contained.' : `After: contained (${extraTrips} lines tripped, ${loadShedPct}% load shed).`)
          : `After: cascade continues (${extraTrips} lines tripped, ${loadShedPct}% load shed).`;

        set({
          replayData: replay,
          replayStepIndex: 0,
          verifiedFixResult: {
            before: beforeDesc,
            after: afterDesc,
            contained: isContained
          },
          loadingReplay: false
        });
      } else {
        set({ loadingReplay: false });
      }
    } catch (err) {
      console.error('Failed to verify fix:', err);
      set({ loadingReplay: false });
    }
  },

  // Dataset Splits
  datasetSplits: null,
  loadingDatasetSplits: false,
  fetchDatasetSplits: async () => {
    set({ loadingDatasetSplits: true });
    try {
      const res = await fetch(`${API_BASE}/dataset/splits`);
      if (res.ok) {
        const data: DatasetSplitsResponse = await res.json();
        set({ datasetSplits: data, loadingDatasetSplits: false });
      } else {
        set({ loadingDatasetSplits: false });
      }
    } catch (err) {
      console.error('Failed to fetch dataset splits:', err);
      set({ loadingDatasetSplits: false });
    }
  },

  fetchResults: async () => {
    set({ loadingResults: true });
    try {
      const res = await fetch(`${API_BASE}/results`);
      if (res.ok) {
        const data = await res.json();
        set({ resultsData: data, loadingResults: false });
      }
    } catch (err) {
      console.error('Failed to load benchmark results:', err);
      set({ loadingResults: false });
    }
  },

  // ---------------------------------------------------------------------------
  // Maintenance Prioritisation & Outage Planning Implementation
  // ---------------------------------------------------------------------------
  maintenanceData: null,
  loadingMaintenance: false,
  maintenanceError: null,
  maintenanceLoadProfile: DEFAULT_24H_LOAD_PROFILE,
  setMaintenanceLoadProfile: (profile: number[]) => set({ maintenanceLoadProfile: profile }),
  selectedMaintenanceAsset: null,
  setSelectedMaintenanceAsset: (id: string | null) => set({ selectedMaintenanceAsset: id }),
  plannedOutageResult: null,
  loadingPlannedOutage: false,
  plannedOutageError: null,
  showMaintenanceOverlay: false,
  toggleMaintenanceOverlay: () => set((s) => ({ showMaintenanceOverlay: !s.showMaintenanceOverlay })),

  fetchMaintenancePriorities: async (customProfile?: number[]) => {
    const { gridCase, maintenanceLoadProfile } = get();
    const profile = customProfile || maintenanceLoadProfile;
    set({ loadingMaintenance: true, maintenanceError: null });
    try {
      const res = await fetch(`${API_BASE}/maintenance/priority`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grid_id: gridCase, load_profile: profile })
      });
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      const data: MaintenancePriorityResponse = await res.json();
      set((state) => ({
        maintenanceData: data,
        loadingMaintenance: false,
        maintenanceError: null,
        selectedMaintenanceAsset: state.selectedMaintenanceAsset || (data.priorities[0]?.asset_id ?? null)
      }));

      // Automatically evaluate planned outage for top asset if not yet evaluated
      const targetAsset = get().selectedMaintenanceAsset || data.priorities[0]?.asset_id;
      if (targetAsset) {
        get().evaluatePlannedOutage(targetAsset, profile);
      }
    } catch (err: any) {
      set({
        loadingMaintenance: false,
        maintenanceError: err.message || 'Failed to compute maintenance priorities'
      });
    }
  },

  evaluatePlannedOutage: async (assetId: string, customProfile?: number[]) => {
    const { gridCase, maintenanceLoadProfile } = get();
    const profile = customProfile || maintenanceLoadProfile;
    set({ loadingPlannedOutage: true, plannedOutageError: null, selectedMaintenanceAsset: assetId });
    try {
      const res = await fetch(`${API_BASE}/maintenance/planned-outage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grid_id: gridCase, asset_id: assetId, load_profile: profile })
      });
      if (!res.ok) {
        throw new Error(`Outage evaluation failed with status ${res.status}`);
      }
      const data: PlannedOutageResponse = await res.json();
      set({
        plannedOutageResult: data,
        loadingPlannedOutage: false,
        plannedOutageError: null
      });
    } catch (err: any) {
      set({
        loadingPlannedOutage: false,
        plannedOutageError: err.message || 'Failed to evaluate planned outage'
      });
    }
  },

  uploadAssetCsv: async (file: File) => {
    const { gridCase } = get();
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/maintenance/assets/upload?grid_id=${gridCase}`, {
      method: 'POST',
      body: formData
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Upload failed' }));
      throw new Error(err.detail || 'Asset upload failed');
    }
    const data = await res.json();
    await get().fetchMaintenancePriorities();
    return data;
  },

  // ---------------------------------------------------------------------------
  // Notifications & Outbox Implementation
  // ---------------------------------------------------------------------------
  notificationsOpen: false,
  setNotificationsOpen: (open: boolean) => set({ notificationsOpen: open }),
  toggleNotifications: () => set((s) => ({ notificationsOpen: !s.notificationsOpen })),
  notificationSettings: null,
  notificationRules: [],
  outboxEmails: [],
  notificationHistory: [],
  loadingNotifications: false,

  fetchNotificationSettings: async () => {
    try {
      const res = await fetch(`${API_BASE}/notifications/settings`);
      if (res.ok) {
        const data = await res.json();
        set({ notificationSettings: data });
      }
    } catch (err) {
      console.error('Failed to fetch notification settings:', err);
    }
  },

  fetchNotificationRules: async () => {
    try {
      const res = await fetch(`${API_BASE}/notifications/rules`);
      if (res.ok) {
        const data = await res.json();
        set({ notificationRules: data.rules || [] });
      }
    } catch (err) {
      console.error('Failed to fetch notification rules:', err);
    }
  },

  createNotificationRule: async (rule: Partial<NotificationRule>) => {
    set({ loadingNotifications: true });
    try {
      const res = await fetch(`${API_BASE}/notifications/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rule)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Failed to create rule' }));
        throw new Error(err.detail || 'Rule creation failed');
      }
      const newRule = await res.json();
      await get().fetchNotificationRules();
      set({ loadingNotifications: false });
      return newRule;
    } catch (err: any) {
      set({ loadingNotifications: false });
      throw err;
    }
  },

  deleteNotificationRule: async (id: string) => {
    try {
      await fetch(`${API_BASE}/notifications/rules/${id}`, { method: 'DELETE' });
      await get().fetchNotificationRules();
    } catch (err) {
      console.error('Failed to delete rule:', err);
    }
  },

  updateNotificationSettings: async (settings: Partial<NotificationSettings>) => {
    try {
      const res = await fetch(`${API_BASE}/notifications/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        const data = await res.json();
        set({ notificationSettings: data });
      }
    } catch (err) {
      console.error('Failed to update notification settings:', err);
    }
  },

  sendTestNotificationEmail: async (recipient: string) => {
    set({ loadingNotifications: true });
    try {
      const res = await fetch(`${API_BASE}/notifications/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient })
      });
      const data = await res.json();
      await get().fetchOutboxEmails();
      await get().fetchNotificationHistory();
      set({ loadingNotifications: false });
      return data;
    } catch (err: any) {
      set({ loadingNotifications: false });
      throw err;
    }
  },

  sendDigestNotificationEmail: async (gridId?: string) => {
    const { gridCase } = get();
    set({ loadingNotifications: true });
    try {
      const res = await fetch(`${API_BASE}/notifications/digest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grid_id: gridId || gridCase })
      });
      const data = await res.json();
      await get().fetchOutboxEmails();
      await get().fetchNotificationHistory();
      set({ loadingNotifications: false });
      return data;
    } catch (err: any) {
      set({ loadingNotifications: false });
      throw err;
    }
  },

  runNotificationCheckNow: async () => {
    set({ loadingNotifications: true });
    try {
      const res = await fetch(`${API_BASE}/notifications/run-check-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      await get().fetchOutboxEmails();
      await get().fetchNotificationHistory();
      set({ loadingNotifications: false });
      return data;
    } catch (err: any) {
      set({ loadingNotifications: false });
      throw err;
    }
  },

  fetchOutboxEmails: async () => {
    try {
      const res = await fetch(`${API_BASE}/notifications/outbox`);
      if (res.ok) {
        const data = await res.json();
        set({ outboxEmails: data.emails || [] });
      }
    } catch (err) {
      console.error('Failed to fetch outbox emails:', err);
    }
  },

  fetchNotificationHistory: async () => {
    try {
      const res = await fetch(`${API_BASE}/notifications/history`);
      if (res.ok) {
        const data = await res.json();
        set({ notificationHistory: data.history || [] });
      }
    } catch (err) {
      console.error('Failed to fetch notification history:', err);
    }
  }
}));
