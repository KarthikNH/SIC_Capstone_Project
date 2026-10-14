import React, { useState, useRef, useEffect } from 'react';
import { useGridStore } from '../store';
import type { MitigationAction } from '../types';
import {
  MessageSquare,
  X,
  RotateCcw,
  Send,
  Sparkles,
  Bot,
  User,
  Check,
  Zap,
  Info
} from 'lucide-react';

export const ChatDrawer: React.FC = () => {
  const {
    chatOpen,
    setChatOpen,
    toggleChat,
    chatMessages,
    chatStreaming,
    isOfflineChat,
    chatActionNotification,
    setChatActionNotification,
    sendChatMessage,
    resetChat,
    verifyMitigation,
    setLoadScale,
    setOutagedElements,
    outagedElements,
    loadScale,
    gridCase
  } = useGridStore();

  const [inputVal, setInputVal] = useState('');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Suggested prompt chips
  const suggestedChips = [
    'Why is the risk high?',
    'Suggest a fix',
    'What does this dataset contain?',
    'Inspect topology cut-edges',
    'Show criticality map'
  ];

  // Auto-scroll to bottom on message updates
  useEffect(() => {
    if (chatOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, chatOpen]);

  // Focus input on open
  useEffect(() => {
    if (chatOpen) {
      inputRef.current?.focus();
    }
  }, [chatOpen]);

  // Handle escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && chatOpen) {
        setChatOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [chatOpen, setChatOpen]);

  // Auto-dismiss action notification after 4s
  useEffect(() => {
    if (chatActionNotification) {
      const timer = setTimeout(() => {
        setChatActionNotification(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [chatActionNotification, setChatActionNotification]);

  const handleSend = async (textToSend?: string) => {
    const query = textToSend || inputVal;
    if (!query.trim() || chatStreaming) return;
    setInputVal('');
    await sendChatMessage(query.trim());
  };

  const handleVerify = async (action: MitigationAction) => {
    setVerifyingId(action.id);
    try {
      await verifyMitigation(action.id);
    } finally {
      setVerifyingId(null);
    }
  };

  const handleApplyMitigation = (action: MitigationAction) => {
    if (action.action_type === 'load_curtailment' && action.curtailment_scale) {
      setLoadScale(action.curtailment_scale);
      setChatActionNotification(`Applied load adjustment to ${Math.round(action.curtailment_scale * 100)}%`);
    } else if (action.action_type === 'restore_element') {
      const remaining = outagedElements.filter((el) => el !== `line_${action.restore_branch_id}`);
      setOutagedElements(remaining);
      setChatActionNotification(`Restored line ${action.restore_branch_id} to service`);
    } else {
      setLoadScale(0.95);
      setChatActionNotification(`Applied ${action.title}`);
    }
  };

  return (
    <>
      {/* Floating Bottom-Right Button */}
      {!chatOpen && (
        <button
          onClick={toggleChat}
          className="fixed bottom-6 right-6 z-40 bg-charcoal text-white px-4 py-2.5 rounded-none shadow-xl border border-white/20 flex items-center gap-2 hover:bg-black transition-all hover:scale-105 active:scale-95 select-none"
          title="Open Grid Assistant Chat"
          aria-label="Open Grid Assistant Chat"
        >
          <div className="relative">
            <Bot className="w-4 h-4 text-amber" />
            <span className="w-2 h-2 rounded-full bg-emerald-400 absolute -top-1 -right-1" />
          </div>
          <span className="text-xs font-semibold tracking-wide">Grid Assistant</span>
        </button>
      )}

      {/* Backdrop overlay */}
      {chatOpen && (
        <div
          onClick={() => setChatOpen(false)}
          className="fixed inset-0 z-40 bg-black/25 backdrop-blur-2xs transition-opacity"
        />
      )}

      {/* Side Drawer Container */}
      <div
        className={`fixed top-0 right-0 h-full w-[460px] max-w-[95vw] z-50 bg-white border-l border-[#cfd3d8] shadow-2xl flex flex-col transition-transform duration-300 ease-in-out ${
          chatOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        role="dialog"
        aria-label="Grid Assistant Side Drawer"
      >
        {/* Drawer Header */}
        <div className="p-4 border-b border-[#cfd3d8] bg-[#fafafa] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-none bg-charcoal text-white flex items-center justify-center">
              <Bot className="w-4 h-4 text-amber" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-ink">Grid Assistant</h3>
                {isOfflineChat ? (
                  <span className="px-1.5 py-0.5 bg-[#fef3c7] text-[#92400e] border border-[#fde68a] text-[10px] font-bold uppercase rounded-none">
                    Offline Mode
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 bg-[#dcfce7] text-[#166534] border border-[#bbf7d0] text-[10px] font-bold uppercase rounded-none">
                    Active
                  </span>
                )}
              </div>
              <span className="text-[11px] font-mono text-[#666]">
                Context: {gridCase.toUpperCase()} · {outagedElements.join(', ') || 'No Outage'} · {Math.round(loadScale * 100)}% Load
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={resetChat}
              className="p-1.5 text-[#666] hover:text-ink hover:bg-[#e5e7eb] rounded-none transition-colors"
              title="Reset conversation"
              aria-label="Reset conversation"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setChatOpen(false)}
              className="p-1.5 text-[#666] hover:text-red hover:bg-[#e5e7eb] rounded-none transition-colors ml-1"
              title="Close drawer (Esc)"
              aria-label="Close drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Mandatory Operator Decision Support Note */}
        <div className="bg-[#fffbeb] px-4 py-2 border-b border-[#fef3c7] text-[11px] text-[#92400e] flex items-center gap-2">
          <Info className="w-3.5 h-3.5 shrink-0 text-amber" />
          <span>Decision-support only. Always verify recommendations with power grid control operators.</span>
        </div>

        {/* Action Confirmation Banner Toast */}
        {chatActionNotification && (
          <div className="bg-charcoal text-white px-4 py-2 text-xs flex items-center justify-between border-b border-black/20 animate-fade-in">
            <div className="flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-amber" />
              <span>UI Action Executed: <strong>{chatActionNotification}</strong></span>
            </div>
            <button
              onClick={() => setChatActionNotification(null)}
              className="text-[#999] hover:text-white ml-2 text-xs"
            >
              ×
            </button>
          </div>
        )}

        {/* Chat Messages Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-white">
          {chatMessages.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[#888]">
              <MessageSquare className="w-8 h-8 text-[#ccc] mb-2" />
              <p className="text-xs">No messages yet. Ask a question or click a suggested prompt.</p>
            </div>
          )}

          {chatMessages.map((msg) => {
            const isUser = msg.role === 'user';
            return (
              <div
                key={msg.id}
                className={`flex gap-2.5 ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                {!isUser && (
                  <div className="w-6 h-6 rounded-none bg-charcoal text-white flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="w-3.5 h-3.5 text-amber" />
                  </div>
                )}

                <div
                  className={`max-w-[85%] text-xs p-3 space-y-2.5 ${
                    isUser
                      ? 'bg-charcoal text-white rounded-none shadow-2xs font-medium'
                      : 'bg-[#f9fafb] text-ink border border-[#e5e7eb] rounded-none shadow-2xs'
                  }`}
                >
                  {/* Tool Call indicator */}
                  {!isUser && msg.toolCalls && msg.toolCalls.length > 0 && (
                    <div className="flex flex-wrap gap-1 border-b border-[#e5e7eb] pb-1.5">
                      {msg.toolCalls.map((tc, i) => (
                        <span
                          key={i}
                          className="px-1.5 py-0.5 bg-white border border-[#cfd3d8] text-[10px] font-mono text-[#555] flex items-center gap-1"
                        >
                          <Sparkles className="w-2.5 h-2.5 text-amber" />
                          <span>Tool: {tc.name}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Message Markdown/Content */}
                  <div className="leading-relaxed whitespace-pre-wrap break-words">
                    {msg.content}
                    {msg.isStreaming && (
                      <span className="inline-block w-1.5 h-3.5 bg-charcoal ml-1 animate-pulse align-middle" />
                    )}
                  </div>

                  {/* Ranked Mitigation Cards (if returned by tool) */}
                  {!isUser && msg.mitigationActions && msg.mitigationActions.length > 0 && (
                    <div className="mt-2 space-y-2.5 border-t border-[#e5e7eb] pt-2">
                      <span className="eyebrow block">Recommended Countermeasures:</span>
                      {msg.mitigationActions.map((act) => {
                        const isVerified = act.status === 'simulator verified';
                        return (
                          <div
                            key={act.id || act.title}
                            className="p-2.5 border border-[#cfd3d8] bg-white space-y-2 shadow-2xs"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <h5 className="font-semibold text-ink text-xs">{act.title}</h5>
                                <p className="text-[11px] text-[#666] leading-tight mt-0.5">
                                  {act.description}
                                </p>
                              </div>
                              <span
                                className={`px-2 py-0.5 text-[9.5px] font-bold uppercase shrink-0 border ${
                                  isVerified
                                    ? 'bg-[#dcfce7] text-[#166534] border-[#bbf7d0]'
                                    : 'bg-[#f3f4f6] text-[#555] border-[#d1d5db]'
                                }`}
                              >
                                {isVerified ? 'Simulator Verified' : 'Model Estimate'}
                              </span>
                            </div>

                            <div className="flex items-center justify-between text-[11px] pt-1 border-t border-[#f0f0f0]">
                              <div>
                                <span className="text-[#666]">Projected Risk: </span>
                                <span className="font-mono font-semibold text-ink">
                                  {Math.round(act.predicted_risk * 100)}%
                                </span>
                                <span className="text-[#166534] font-mono font-medium ml-1">
                                  (-{Math.round(act.risk_reduction * 100)}%)
                                </span>
                              </div>

                              <div className="flex items-center gap-1.5">
                                <button
                                  onClick={() => handleApplyMitigation(act)}
                                  className="px-2 py-1 bg-charcoal text-white hover:bg-black text-[10.5px] font-medium transition-colors"
                                >
                                  Apply Fix
                                </button>

                                {!isVerified && (
                                  <button
                                    onClick={() => handleVerify(act)}
                                    disabled={verifyingId === act.id}
                                    className="px-2 py-1 border border-[#cfd3d8] bg-[#f9fafb] text-[#555] hover:text-ink hover:bg-white text-[10.5px] font-medium transition-colors"
                                  >
                                    {verifyingId === act.id ? 'Verifying...' : 'Verify in Simulator'}
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Verified Details */}
                            {act.simulator_verification && (
                              <div className="p-1.5 bg-[#f0fdf4] border border-[#bbf7d0] text-[10.5px] text-[#166534] flex items-center justify-between font-mono">
                                <span>
                                  Cascade Prevented: <strong>{act.simulator_verification.cascade_prevented ? 'YES' : 'NO'}</strong>
                                </span>
                                <span>Trips: {act.simulator_verification.simulated_additional_trips} lines</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* UI Action confirmations */}
                  {!isUser && msg.actions && msg.actions.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-[#e5e7eb]">
                      {msg.actions.map((act, idx) => (
                        <div
                          key={idx}
                          className="text-[10.5px] text-[#15803d] flex items-center gap-1 font-mono"
                        >
                          <Check className="w-3 h-3 text-[#166534]" />
                          <span>{act.description}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {isUser && (
                  <div className="w-6 h-6 rounded-none bg-[#e5e7eb] text-ink flex items-center justify-center shrink-0 mt-0.5">
                    <User className="w-3.5 h-3.5" />
                  </div>
                )}
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Suggested Prompt Chips */}
        <div className="p-3 bg-[#fafafa] border-t border-[#e5e7eb] space-y-2">
          <span className="eyebrow block">Quick Questions:</span>
          <div className="flex flex-wrap gap-1.5">
            {suggestedChips.map((chip) => (
              <button
                key={chip}
                onClick={() => handleSend(chip)}
                disabled={chatStreaming}
                className="text-[11px] px-2.5 py-1 bg-white border border-[#cfd3d8] text-[#444] hover:text-ink hover:border-charcoal transition-colors disabled:opacity-50"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {/* Input Footer */}
        <div className="p-3 border-t border-[#cfd3d8] bg-white flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask about risk, fixes, or topology..."
            disabled={chatStreaming}
            className="flex-1 text-xs px-3 py-2 border border-[#cfd3d8] bg-white text-ink placeholder:text-[#999] focus:outline-none focus:border-charcoal disabled:opacity-60"
          />
          <button
            onClick={() => handleSend()}
            disabled={!inputVal.trim() || chatStreaming}
            className="btn-estate-dark py-2 px-3 text-xs flex items-center gap-1 disabled:opacity-40"
          >
            <Send className="w-3 h-3" />
            <span>Send</span>
          </button>
        </div>
      </div>
    </>
  );
};
