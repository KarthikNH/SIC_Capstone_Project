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
  ChatMessage
} from './types';

// Single source of truth for backend API base URL
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

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

  // Tabs state: Warning (default), Why, Stats, Data
  activeTab: 'warning' | 'why' | 'stats' | 'data';
  setActiveTab: (tab: 'warning' | 'why' | 'stats' | 'data') => void;

  // View Mode: 3D vs Map vs City
  viewMode: '3d' | 'map' | 'city';
  setViewMode: (mode: '3d' | 'map' | 'city') => void;

  // Topology Overlay state (Map mode)
  topologyOverlay: 'none' | 'degree' | 'betweenness' | 'community' | 'bridges';
  setTopologyOverlay: (overlay: 'none' | 'degree' | 'betweenness' | 'community' | 'bridges') => void;
  topologyData: TopologyData | null;
  loadingTopology: boolean;
  fetchTopology: () => Promise<void>;

  // Dataset Card & Inspector state (Data tab)
  datasetCard: DatasetCardResponse | null;
  loadingDatasetCard: boolean;
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
  startCascadeReplay: () => Promise<void>;
  stopCascadeReplay: () => void;
  setReplayStepIndex: (step: number) => void;
  togglePlayPauseReplay: () => void;

  fetchGridAndLayout: () => Promise<void>;
  fetchGridStats: () => Promise<void>;
  fetchPrediction: () => Promise<void>;
  fetchResults: () => Promise<void>;
}

export const useGridStore = create<GridState>((set, get) => ({
  gridCase: 'case30',
  setGridCase: (c) => {
    set((state) => ({
      gridCase: c,
      outagedElements: ['line_0'],
      outageHistory: [],
      replayData: null,
      replayStepIndex: -1,
      isPlayingReplay: false,
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
    set({ loadScale: val });
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
  fetchDatasetCard: async () => {
    set({ loadingDatasetCard: true });
    try {
      const res = await fetch(`${API_BASE}/dataset/card`);
      if (res.ok) {
        const data: DatasetCardResponse = await res.json();
        set({ datasetCard: data, loadingDatasetCard: false });
      } else {
        set({ loadingDatasetCard: false });
      }
    } catch {
      set({ loadingDatasetCard: false });
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

  startCascadeReplay: async () => {
    const { gridCase, outagedElements, loadScale } = get();
    set({ loadingReplay: true, replayError: null, isPlayingReplay: true });
    try {
      const res = await fetch(`${API_BASE}/cascade-replay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          case: gridCase,
          outaged: outagedElements.length > 0 ? outagedElements : ['line_0'],
          load_scale: loadScale
        })
      });
      if (!res.ok) throw new Error(`Replay server error ${res.status}`);
      const data: CascadeReplayResponse = await res.json();
      set({
        replayData: data,
        replayStepIndex: 0,
        isPlayingReplay: true,
        loadingReplay: false
      });
    } catch (err: any) {
      console.error('Failed to simulate cascade replay:', err);
      set({
        replayError: err.message || 'Simulation replay failed',
        loadingReplay: false,
        isPlayingReplay: false
      });
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

      set({
        buses: gridData.buses || [],
        branches: gridData.branches || [],
        layoutBuses: layoutData.buses || [],
        layoutMap: lMap,
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
    const { gridCase, outagedElements, loadScale } = get();
    set({ loadingPredict: true, predictError: null });
    try {
      const res = await fetch(`${API_BASE}/predict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grid_id: gridCase,
          case: gridCase,
          outaged: outagedElements.length > 0 ? outagedElements : ['line_0'],
          load_scale: loadScale
        })
      });
      if (!res.ok) {
        throw new Error(`Server responded with ${res.status}`);
      }
      const data: PredictResponse = await res.json();
      set({ prediction: data, loadingPredict: false });
    } catch (err: any) {
      console.error('Prediction failed:', err);
      set({ predictError: err.message || 'Prediction failed', loadingPredict: false });
    }

    // Refresh what-if curve alongside
    get().fetchWhatifCurve();
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
  }
}));
